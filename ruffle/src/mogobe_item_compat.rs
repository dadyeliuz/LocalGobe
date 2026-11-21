//! LocalGobe Mogobe Item Compatibility Resolver
//!
//! Provides runtime compatibility for legacy Mogobe builds (Spring 2013)
//! to consume surviving Mogobe item formats (AssetsClean) without modifying,
//! generating, or repacking any SWF binaries.

use crate::avm2::activation::Activation;
use crate::avm2::class::Class;
use crate::avm2::error::Error;
use crate::avm2::function::FunctionArgs;
use crate::avm2::method::MethodAssociation;
use crate::avm2::object::ClassObject;
use crate::avm2::value::Value;
use crate::avm2::{Domain, Method, QName};
use crate::display_object::MovieClip;
use crate::limits::ExecutionLimit;
use crate::string::AvmString;
use crate::tag_utils::{decode_tags, ControlFlow, SwfMovie, SwfSlice};
use std::sync::Arc;
use swf::{PlaceObjectAction, TagCode};

pub fn synthetic_mogobe_item_iinit<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Value<'gc>,
    _args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    activation.super_init(this, FunctionArgs::empty())?;
    Ok(Value::Undefined)
}

pub fn is_mogobe_item_compat_candidate<'gc>(
    activation: &Activation<'_, 'gc>,
    name: AvmString<'gc>,
) -> bool {
    let is_compat_active = activation
        .context
        .root_swf
        .parameters()
        .iter()
        .any(|(k, v)| k == "itemCompatibility" && (v == "true" || v == "1"))
        || activation.context.root_swf.url().contains("itemCompatibility=true");
    if !is_compat_active {
        return false;
    }

    let is_legacy_profile = activation.context.root_swf.url().contains("2013")
        || activation
            .context
            .root_swf
            .parameters()
            .iter()
            .any(|(k, v)| k == "profile" && v.contains("2013"));
    if !is_legacy_profile {
        return false;
    }

    parse_mogobe_item_definition(&name.to_utf8_lossy()).is_some()
}

pub fn parse_mogobe_item_definition(name_str: &str) -> Option<(&'static str, u32)> {
    let (family, id_str) = if let Some(id) = name_str.strip_prefix("mlIconSItem") {
        ("IconS", id)
    } else if let Some(id) = name_str.strip_prefix("mlIconWItem") {
        ("IconW", id)
    } else if let Some(id) = name_str.strip_prefix("mlBigItem") {
        ("BigItem", id)
    } else if let Some(id) = name_str.strip_prefix("btnItem") {
        ("BtnItem", id)
    } else if let Some(id) = name_str.strip_prefix("btnAccessory") {
        ("BtnAccessory", id)
    } else if let Some(id) = name_str.strip_prefix("mlGift") {
        ("Gift", id)
    } else if let Some(id) = name_str.strip_prefix("btnCat") {
        ("Cat", id)
    } else if let Some(id) = name_str.strip_prefix("mlItem") {
        ("RoomItem", id)
    } else {
        return None;
    };

    if id_str.is_empty() || !id_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    let id: u32 = id_str.parse().ok()?;
    Some((family, id))
}

pub fn resolve_mogobe_item_compat<'gc>(
    activation: &mut Activation<'_, 'gc>,
    appdomain: Domain<'gc>,
    name: AvmString<'gc>,
) -> Result<Option<ClassObject<'gc>>, Error<'gc>> {
    if !is_mogobe_item_compat_candidate(activation, name) {
        return Ok(None);
    }

    let name_str = name.to_utf8_lossy();
    let (family, item_id) = match parse_mogobe_item_definition(&name_str) {
        Some(v) => v,
        None => return Ok(None),
    };

    let name_qname = QName::new(activation.avm2().namespaces.public_all(), name);

    // If already exported in domain, return its class_object
    if let Some(existing_class) = appdomain.get_class(activation.context, &name_qname.into()) {
        if let Some(obj) = existing_class.class_object() {
            return Ok(Some(obj));
        }
    }

    let asset_path = format!("/Swf/AssetsClean/Items/{family}/{item_id}.swf?profile=20130526");
    let asset_url = if let Ok(root_url) = url::Url::parse(activation.context.root_swf.url()) {
        if let Ok(joined) = root_url.join(&asset_path) {
            joined.to_string()
        } else {
            asset_path.clone()
        }
    } else {
        asset_path.clone()
    };
    let bytes = activation.context.navigator.fetch_sync(&asset_path);
    let Some(bytes) = bytes else {
        return Ok(None);
    };

    let movie = match SwfMovie::from_data(&bytes, asset_url.clone(), None, None) {
        Ok(m) => Arc::new(m),
        Err(e) => {
            tracing::warn!("Failed to parse AssetsClean movie {}: {}", asset_url, e);
            return Ok(None);
        }
    };

    // Find the symbol character ID placed with this name
    let target_name = name_str.as_ref();
    let mut symbol_id = None;
    let slice = SwfSlice::from(movie.clone());
    let mut stream = slice.read_from(0);
    let encoding = movie.encoding();

    let _ = decode_tags(&mut stream, |reader, tag| {
        match tag {
            TagCode::PlaceObject2 | TagCode::PlaceObject3 | TagCode::PlaceObject4 => {
                let version = match tag {
                    TagCode::PlaceObject2 => 2,
                    TagCode::PlaceObject3 => 3,
                    TagCode::PlaceObject4 => 4,
                    _ => unreachable!(),
                };
                if let Ok(po) = reader.read_place_object_2_or_3(version) {
                    if let Some(po_name) = po.name {
                        let name_lossy = po_name.to_str_lossy(encoding);
                        if name_lossy.trim().eq_ignore_ascii_case(target_name) {
                            if let PlaceObjectAction::Place(cid) | PlaceObjectAction::Replace(cid) = po.action {
                                symbol_id = Some(cid);
                                return Ok(ControlFlow::Exit);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(ControlFlow::Continue)
    });

    // Fallback: search for any PlaceObject tag with a character ID or DefineSprite
    if symbol_id.is_none() {
        let mut stream = slice.read_from(0);
        let _ = decode_tags(&mut stream, |reader, tag| {
            match tag {
                TagCode::PlaceObject2 | TagCode::PlaceObject3 | TagCode::PlaceObject4 => {
                    let version = match tag {
                        TagCode::PlaceObject2 => 2,
                        TagCode::PlaceObject3 => 3,
                        TagCode::PlaceObject4 => 4,
                        _ => unreachable!(),
                    };
                    if let Ok(po) = reader.read_place_object_2_or_3(version) {
                        if let PlaceObjectAction::Place(cid) | PlaceObjectAction::Replace(cid) = po.action {
                            symbol_id = Some(cid);
                            return Ok(ControlFlow::Exit);
                        }
                    }
                }
                TagCode::DefineSprite => {
                    if let Ok(sprite) = reader.read_define_sprite() {
                        symbol_id = Some(sprite.id);
                    }
                }
                _ => {}
            }
            Ok(ControlFlow::Continue)
        });
    }

    let Some(symbol_id) = symbol_id else {
        return Ok(None);
    };

    // Ensure movie library exists and has domain set before preloading symbols
    let movie_lib = activation.context.library.library_for_movie_mut(movie.clone());
    if movie_lib.try_avm2_domain().is_none() {
        movie_lib.set_avm2_domain(appdomain);
    }
    let root_clip = MovieClip::new_for_movie(activation.context, movie.clone());
    root_clip.preload(activation.context, &mut ExecutionLimit::none());

    // Construct dynamic Class inheriting from MovieClip
    let movieclip_cls_obj = activation.avm2().classes().movieclip;
    let super_class = movieclip_cls_obj.inner_class_definition();
    let super_init = super_class
        .instance_init()
        .expect("MovieClip must have instance_init");

    let synthetic_iinit = Method::synthetic_native(
        activation,
        super_init.translation_unit(),
        super_init.abc_method_index(),
        synthetic_mogobe_item_iinit,
    );

    let class = Class::custom_subclass(
        activation.context,
        name_qname,
        super_class,
        Some(synthetic_iinit),
    )
    .map_err(|e| e.into_avm(activation))?;

    synthetic_iinit.associate(
        activation,
        MethodAssociation::classbound(class, Some(movieclip_cls_obj), false),
    )?;

    let class_object = ClassObject::from_class_partial(
        activation,
        class,
        Some(movieclip_cls_obj),
    );

    activation
        .context
        .library
        .avm2_class_registry_mut()
        .set_class_symbol(class, movie.clone(), symbol_id);

    let library = activation
        .context
        .library
        .library_for_movie_mut(movie.clone());
    if let Some(crate::character::Character::MovieClip(mc_char)) = library.character_by_id(symbol_id) {
        mc_char.set_avm2_class(activation.gc(), Some(class_object));
    }

    appdomain.export_class(name_qname, class, activation.gc());
    let stage_domain = activation.context.avm2.stage_domain();
    if stage_domain != appdomain {
        stage_domain.export_class(name_qname, class, activation.gc());
    }

    tracing::info!(
        "[localgobe] Legacy Mogobe item asset missing; using original AssetsClean compatibility asset: item_id={}, requested legacy definition={}, family={}, url={}",
        item_id, target_name, family, asset_url
    );

    Ok(Some(class_object))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PlayerBuilder;
    use crate::avm2::activation::Activation as Avm2Activation;
    use crate::avm2::object::TObject;

    #[test]
    fn test_mogobe_item_constructors() {
        let swf_bytes = include_bytes!("../../../../../../tests/tests/swfs/avm2/add/test.swf");
        let movie = SwfMovie::from_data(
            swf_bytes,
            "http://127.0.0.1:5173/game/Swf/Mogo.swf?profile=20130526&itemCompatibility=true".to_string(),
            None,
            None,
        )
        .expect("Failed to parse test SWF");

        let player = PlayerBuilder::new().with_movie(movie).build();
        player.lock().unwrap().mutate_with_update_context(|context| {
            let mut activation = Avm2Activation::from_nothing(context);
            let appdomain = activation.context.avm2.stage_domain();

            let item_classes = [
                "btnItem109",
                "mlBigItem109",
                "mlIconSItem109",
                "mlIconWItem109",
                "btnItem110",
                "mlBigItem110",
                "mlIconSItem110",
                "mlIconWItem110",
            ];

            for class_name in item_classes {
                let name = AvmString::new_utf8(activation.gc(), class_name);
                let cls_obj = resolve_mogobe_item_compat(&mut activation, appdomain, name)
                    .expect("resolve_mogobe_item_compat should succeed")
                    .expect("Class should be found");

                // Verify domain definition / applicationDomain.getDefinition
                let name_qname = QName::new(activation.avm2().namespaces.public_all(), name);
                let looked_up = appdomain
                    .get_class(activation.context, &name_qname.into())
                    .expect("Class definition should be exported to domain")
                    .class_object()
                    .expect("Class should have ClassObject");
                assert_eq!(cls_obj, looked_up, "Exported class object should match for {}", class_name);

                // Test instantiation (calling constructor twice)
                let inst1 = match cls_obj.construct(&mut activation, &[]) {
                    Ok(val) => val,
                    Err(err) => {
                        let err_str = err.to_string(&mut activation);
                        eprintln!("[test_mogobe_item_109_constructors] Instantiation error for {}: {}", class_name, err_str);
                        panic!("First instantiation failed for {}: {}", class_name, err_str);
                    }
                };
                let inst2 = cls_obj
                    .construct(&mut activation, &[])
                    .expect("Second instantiation should succeed");

                let obj1 = inst1.as_object().expect("Result 1 should be object");
                let obj2 = inst2.as_object().expect("Result 2 should be object");

                // Verify distinct instances
                assert_ne!(
                    obj1.as_ptr(),
                    obj2.as_ptr(),
                    "Each instantiation must create a distinct object instance for {}",
                    class_name
                );

                // Verify MovieClip & timeline
                let mc = obj1
                    .as_display_object()
                    .and_then(|d| d.as_movie_clip())
                    .expect("Constructed object must be a MovieClip");
                assert!(
                    mc.header_frames() >= 1,
                    "Constructed MovieClip must have at least 1 frame for {}",
                    class_name
                );
            }
        });
    }
}

