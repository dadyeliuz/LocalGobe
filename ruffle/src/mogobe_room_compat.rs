//! LocalGobe Mogobe Room Compatibility Resolver
//!
//! Provides runtime compatibility for legacy Mogobe builds (Spring 2013)
//! to consume surviving Mogobe room formats (SWF + TXT and SWF-only) without
//! modifying, generating, or repacking any SWF binaries.

use crate::avm2::activation::Activation;
use crate::avm2::array::ArrayStorage;
use crate::avm2::class::Class;
use crate::avm2::error::Error;
use crate::avm2::function::FunctionArgs;
use crate::avm2::method::MethodAssociation;
use crate::avm2::object::{ArrayObject, ClassObject, FunctionObject, Object, ScriptObject, TObject};
use crate::avm2::value::Value;
use crate::avm2::{Domain, Method, Multiname, QName};
use crate::context::UpdateContext;
use crate::display_object::{
    BoundsMode, DisplayObject, MovieClip, TDisplayObject, TDisplayObjectContainer,
};
use crate::limits::ExecutionLimit;
use crate::string::{AvmString, WStr};
use crate::tag_utils::{decode_tags, ControlFlow, SwfMovie, SwfSlice};
use std::sync::Arc;
use swf::{PlaceObjectAction, TagCode};

pub fn synthetic_mogobe_room_iinit<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Value<'gc>,
    _args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    activation.super_init(this, FunctionArgs::empty())?;
    Ok(Value::Undefined)
}

pub fn synthetic_mogobe_interactive_stop<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Value<'gc>,
    _args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(mc) = this
        .as_object()
        .and_then(|obj| obj.as_display_object())
        .and_then(|dobj| dobj.as_movie_clip())
    {
        mc.stop(activation.context);
    }
    Ok(Value::Undefined)
}

fn resolve_display_child_path<'gc>(
    activation: &mut Activation<'_, 'gc>,
    root: Object<'gc>,
    path: &str,
) -> Result<Option<Value<'gc>>, Error<'gc>> {
    let mut current = root;
    for part in path.split('.') {
        let part_trimmed = part.trim();
        if part_trimmed.is_empty() {
            continue;
        }
        let part_str = AvmString::new_utf8(activation.gc(), part_trimmed);
        let get_child_prop = Multiname::new(
            activation.avm2().namespaces.public_all(),
            AvmString::new_utf8(activation.gc(), "getChildByName"),
        );
        let child_val = Value::from(current).call_property(
            &get_child_prop,
            FunctionArgs::from_slice(&[part_str.into()]),
            activation,
        );
        match child_val {
            Ok(v) if v.as_object().is_some() => {
                current = v.as_object().unwrap();
            }
            _ => {
                let prop_multiname = Multiname::new(
                    activation.avm2().namespaces.public_all(),
                    part_str,
                );
                if let Ok(prop_val) = Value::from(current).get_property(&prop_multiname, activation) {
                    if let Some(prop_obj) = prop_val.as_object() {
                        current = prop_obj;
                        continue;
                    }
                }
                return Ok(None);
            }
        }
    }
    Ok(Some(current.into()))
}

fn ensure_interactive_movieclip_stopped<'gc>(
    activation: &mut Activation<'_, 'gc>,
    val: Value<'gc>,
    stop_fn: Object<'gc>,
    desc: &str,
) {
    if let Some(mc) = val
        .as_object()
        .and_then(|obj| obj.as_display_object())
        .and_then(|dobj| dobj.as_movie_clip())
    {
        if mc.header_frames() > 1 && !mc.has_frame_script(1) {
            mc.register_frame_script(1, Some(stop_fn), activation.context);
        }
        mc.stop(activation.context);
        tracing::info!(
            "[localgobe-room-compat] Initialized & stopped interactive clip '{}'",
            desc
        );
    }
}

fn convert_room_object_entry<'gc>(
    activation: &mut Activation<'_, 'gc>,
    root: Object<'gc>,
    item: &serde_json::Map<String, serde_json::Value>,
    stop_fn: Object<'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let obj = ScriptObject::new_object(activation.context);
    for (k, v) in item {
        let prop = AvmString::new_utf8(activation.gc(), k);
        // Special handling for object fields that reference DisplayObject paths
        if (k == "popup" || k == "mc" || k == "targetMc") && v.is_string() {
            let path_str = v.as_str().unwrap().trim();
            if let Some(child_val) = resolve_display_child_path(activation, root, path_str)? {
                ensure_interactive_movieclip_stopped(activation, child_val, stop_fn, path_str);
                obj.set_dynamic_property(prop, child_val, activation.gc());
                continue;
            } else {
                tracing::warn!(
                    "[localgobe-room-compat] Display path '{}' for field '{}' not found in room",
                    path_str,
                    k
                );
            }
        }
        let val = json_value_to_avm2(activation, v)?;
        obj.set_dynamic_property(prop, val, activation.gc());
    }
    Ok(obj.into())
}

fn strip_json_comments_and_trailing_commas(input: &str) -> String {
    let input = input.trim_start_matches('\u{feff}');
    let mut result = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escape = false;
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut i = 0;

    while i < n {
        let c = chars[i];
        if in_string {
            result.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
        } else {
            if c == '"' {
                in_string = true;
                result.push(c);
                i += 1;
            } else if c == '/' && i + 1 < n && chars[i + 1] == '/' {
                i += 2;
                while i < n && chars[i] != '\n' {
                    i += 1;
                }
            } else if c == '/' && i + 1 < n && chars[i + 1] == '*' {
                i += 2;
                while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            } else {
                result.push(c);
                i += 1;
            }
        }
    }

    let mut cleaned = String::with_capacity(result.len());
    let res_chars: Vec<char> = result.chars().collect();
    let rn = res_chars.len();
    let mut j = 0;
    in_string = false;
    escape = false;

    while j < rn {
        let c = res_chars[j];
        if in_string {
            cleaned.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            j += 1;
        } else if c == '"' {
            in_string = true;
            cleaned.push(c);
            j += 1;
        } else if c == ',' {
            let mut k = j + 1;
            while k < rn && res_chars[k].is_whitespace() {
                k += 1;
            }
            if k < rn && (res_chars[k] == '}' || res_chars[k] == ']') {
                j += 1;
            } else {
                cleaned.push(c);
                j += 1;
            }
        } else {
            cleaned.push(c);
            j += 1;
        }
    }

    cleaned
}

fn json_value_to_avm2<'gc>(
    activation: &mut Activation<'_, 'gc>,
    value: &serde_json::Value,
) -> Result<Value<'gc>, Error<'gc>> {
    match value {
        serde_json::Value::Null => Ok(Value::Null),
        serde_json::Value::Bool(b) => Ok(Value::Bool(*b)),
        serde_json::Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                Ok(Value::Number(f))
            } else {
                Ok(Value::Number(0.0))
            }
        }
        serde_json::Value::String(s) => {
            Ok(AvmString::new_utf8(activation.gc(), s).into())
        }
        serde_json::Value::Array(arr) => {
            let mut elements = Vec::with_capacity(arr.len());
            for item in arr {
                elements.push(json_value_to_avm2(activation, item)?);
            }
            Ok(ArrayObject::from_storage(
                activation.context,
                ArrayStorage::from_args(&elements),
            )
            .into())
        }
        serde_json::Value::Object(map) => {
            let obj = ScriptObject::new_object(activation.context);
            for (k, v) in map {
                let prop = AvmString::new_utf8(activation.gc(), k);
                let val = json_value_to_avm2(activation, v)?;
                obj.set_dynamic_property(prop, val, activation.gc());
            }
            Ok(obj.into())
        }
    }
}

fn sanitize_and_stop_interactive_movie_clips<'gc>(
    context: &mut UpdateContext<'gc>,
    dobj: DisplayObject<'gc>,
    stop_fn: Object<'gc>,
) {
    if let Some(mc) = dobj.as_movie_clip() {
        let has_over_label = mc
            .frame_label_to_number(WStr::from_units(b"OVER"), context)
            .is_some();
        if has_over_label && mc.header_frames() > 1 {
            if !mc.has_frame_script(1) {
                mc.register_frame_script(1, Some(stop_fn), context);
            }
            mc.stop(context);
        }
    }
    if let Some(container) = dobj.as_container() {
        for child in container.iter_render_list() {
            sanitize_and_stop_interactive_movie_clips(context, child, stop_fn);
        }
    }
}

fn ensure_interactive_cursor_hit_areas<'gc>(
    activation: &mut Activation<'_, 'gc>,
    room_obj: Object<'gc>,
) -> Result<(), Error<'gc>> {
    let cursor_container_val =
        resolve_display_child_path(activation, room_obj, "mcIntractiveCursor")?;
    let Some(cursor_container_val) = cursor_container_val else {
        return Ok(());
    };
    let Some(cursor_container_obj) = cursor_container_val.as_object() else {
        return Ok(());
    };

    let num_children_prop = Multiname::new(
        activation.avm2().namespaces.public_all(),
        AvmString::new_utf8(activation.gc(), "numChildren"),
    );
    let num_children_val =
        Value::from(cursor_container_obj).get_property(&num_children_prop, activation)?;
    let num_children = num_children_val.coerce_to_i32(activation)?;

    let get_child_at_prop = Multiname::new(
        activation.avm2().namespaces.public_all(),
        AvmString::new_utf8(activation.gc(), "getChildAt"),
    );
    let graphics_prop = Multiname::new(
        activation.avm2().namespaces.public_all(),
        AvmString::new_utf8(activation.gc(), "graphics"),
    );
    let begin_fill_prop = Multiname::new(
        activation.avm2().namespaces.public_all(),
        AvmString::new_utf8(activation.gc(), "beginFill"),
    );
    let draw_rect_prop = Multiname::new(
        activation.avm2().namespaces.public_all(),
        AvmString::new_utf8(activation.gc(), "drawRect"),
    );
    let end_fill_prop = Multiname::new(
        activation.avm2().namespaces.public_all(),
        AvmString::new_utf8(activation.gc(), "endFill"),
    );

    for i in 0..num_children {
        let child_val = Value::from(cursor_container_obj).call_property(
            &get_child_at_prop,
            FunctionArgs::from_slice(&[Value::Integer(i)]),
            activation,
        )?;
        let Some(child_obj) = child_val.as_object() else {
            continue;
        };
        let Some(child_dobj) = child_obj.as_display_object() else {
            continue;
        };

        let bounds = child_dobj.bounds(BoundsMode::Engine);
        if bounds.width().to_pixels() <= 0.0 || bounds.height().to_pixels() <= 0.0 {
            if let Ok(graphics_val) =
                Value::from(child_obj).get_property(&graphics_prop, activation)
            {
                if let Some(graphics_obj) = graphics_val.as_object() {
                    let _ = Value::from(graphics_obj).call_property(
                        &begin_fill_prop,
                        FunctionArgs::from_slice(&[Value::Integer(0), Value::Number(0.0)]),
                        activation,
                    );
                    let _ = Value::from(graphics_obj).call_property(
                        &draw_rect_prop,
                        FunctionArgs::from_slice(&[
                            Value::Number(0.0),
                            Value::Number(0.0),
                            Value::Number(50.95),
                            Value::Number(57.0),
                        ]),
                        activation,
                    );
                    let _ = Value::from(graphics_obj)
                        .call_property(&end_fill_prop, FunctionArgs::empty(), activation);

                    let child_name = child_dobj.name().map(|n| n.to_string()).unwrap_or_default();
                    tracing::info!(
                        "[localgobe-room-compat] Synthesized 50.95x57.0 hit area for empty mcIntractiveCursor child '{}'",
                        child_name
                    );
                }
            }
        }
    }

    Ok(())
}

pub fn synthetic_mogobe_room_get_swf_params<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Value<'gc>,
    _args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let this_obj = match this.as_object() {
        Some(obj) => obj,
        None => return Ok(Value::Undefined),
    };

    let class_name = this_obj.instance_class().name().local_name();
    let class_name_str = class_name.to_utf8_lossy();
    let room_id = match parse_mogobe_room_definition(&class_name_str) {
        Some(id) => id,
        None => return Ok(ArrayObject::empty(activation.context).into()),
    };

    let result_obj = ArrayObject::empty(activation.context);

    // Build reusable synthetic frame-0 stop function
    let movieclip_cls_obj = activation.avm2().classes().movieclip;
    let super_class = movieclip_cls_obj.inner_class_definition();
    let super_init = super_class
        .instance_init()
        .expect("MovieClip must have instance_init");

    let stop_method = Method::synthetic_native(
        activation,
        super_init.translation_unit(),
        super_init.abc_method_index(),
        synthetic_mogobe_interactive_stop,
    );
    let stop_fn = FunctionObject::from_method(
        activation.context,
        stop_method,
        movieclip_cls_obj.instance_scope(),
        None,
        Some(movieclip_cls_obj),
    );

    // Recursively scan the room display tree:
    // Any MovieClip containing an "OVER" state is stopped at frame 1 and given a stop frame-script.
    if let Some(dobj) = this_obj.as_display_object() {
        sanitize_and_stop_interactive_movie_clips(activation.context, dobj, stop_fn.into());
    }

    // Ensure interactive transition/arrow cursors have hit testing geometry
    ensure_interactive_cursor_hit_areas(activation, this_obj)?;

    // Fetch companion room_<id>.txt
    let txt_path = format!("/Swf/Rooms/room_{room_id}.txt?profile=20130526");
    let txt_bytes = activation.context.navigator.fetch_sync(&txt_path);

    let companion_json: Option<serde_json::Value> = txt_bytes.and_then(|bytes| {
        let text = std::str::from_utf8(&bytes).ok()?;
        let clean = strip_json_comments_and_trailing_commas(text);
        serde_json::from_str(&clean).ok()
    });

    if let Some(json) = companion_json {
        tracing::info!(
            "[localgobe] Room {room_id} loaded companion metadata: format=SWF+TXT"
        );
        if let Some(scale_up) = json.get("avatarScaleUp").and_then(|v| v.as_f64()) {
            let prop = AvmString::new_utf8(activation.gc(), "avatarScaleUp");
            result_obj.set_dynamic_property(prop, Value::Number(scale_up), activation.gc());
        }
        if let Some(scale_down) = json.get("avatarScaleDown").and_then(|v| v.as_f64()) {
            let prop = AvmString::new_utf8(activation.gc(), "avatarScaleDown");
            result_obj.set_dynamic_property(prop, Value::Number(scale_down), activation.gc());
        }
        let has_zorder = json
            .get("hasZOrderPoints")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let prop = AvmString::new_utf8(activation.gc(), "hasZOrderPoints");
        result_obj.set_dynamic_property(prop, Value::Bool(has_zorder), activation.gc());

        // 1. Array of MovieClip path references
        let array_path_keys = [
            "shopIcon", "gameIcon", "giftIcon", "mov", "movSound", "slingshot",
        ];
        for &key in &array_path_keys {
            if let Some(items) = json.get(key).and_then(|v| v.as_array()) {
                let mut elements = Vec::new();
                for item in items {
                    if let Some(path_str) = item.as_str() {
                        let path_trimmed = path_str.trim();
                        if let Some(child_val) =
                            resolve_display_child_path(activation, this_obj, path_trimmed)?
                        {
                            ensure_interactive_movieclip_stopped(
                                activation,
                                child_val,
                                stop_fn.into(),
                                path_trimmed,
                            );
                            elements.push(child_val);
                            tracing::info!(
                                "[localgobe-room-compat] room={} field={} entry='{}' resolved=true",
                                room_id,
                                key,
                                path_trimmed
                            );
                        } else {
                            tracing::warn!(
                                "[localgobe-room-compat] room={} field={} entry='{}' resolved=false (CHILD_NOT_FOUND)",
                                room_id,
                                key,
                                path_trimmed
                            );
                        }
                    }
                }
                let array_obj = ArrayObject::from_storage(
                    activation.context,
                    ArrayStorage::from_args(&elements),
                );
                let prop = AvmString::new_utf8(activation.gc(), key);
                result_obj.set_dynamic_property(prop, array_obj.into(), activation.gc());
            }
        }

        // 2. Array of structured objects (containing child references like popup/mc/targetMc)
        let object_array_keys = [
            "onClickPopup", "link", "progressBoard", "onTimeEfect", "onTimeEffect",
            "dynamicText", "hitAnimation", "models",
        ];
        for &key in &object_array_keys {
            if let Some(items) = json.get(key).and_then(|v| v.as_array()) {
                let mut elements = Vec::new();
                for item in items {
                    if let Some(map) = item.as_object() {
                        let avm_item = convert_room_object_entry(
                            activation,
                            this_obj,
                            map,
                            stop_fn.into(),
                        )?;
                        elements.push(avm_item);
                    } else if let Some(path_str) = item.as_str() {
                        let path_trimmed = path_str.trim();
                        if let Some(child_val) =
                            resolve_display_child_path(activation, this_obj, path_trimmed)?
                        {
                            ensure_interactive_movieclip_stopped(
                                activation,
                                child_val,
                                stop_fn.into(),
                                path_trimmed,
                            );
                            elements.push(child_val);
                        }
                    }
                }
                let array_obj = ArrayObject::from_storage(
                    activation.context,
                    ArrayStorage::from_args(&elements),
                );
                let prop = AvmString::new_utf8(activation.gc(), key);
                result_obj.set_dynamic_property(prop, array_obj.into(), activation.gc());
                if key == "onTimeEfect" {
                    let alias_prop = AvmString::new_utf8(activation.gc(), "onTimeEffect");
                    result_obj.set_dynamic_property(alias_prop, array_obj.into(), activation.gc());
                }
            }
        }

        // 3. Single MovieClip reference (roomStreaming)
        if let Some(streaming_str) = json.get("roomStreaming").and_then(|v| v.as_str()) {
            let streaming_trimmed = streaming_str.trim();
            if !streaming_trimmed.is_empty() {
                if let Some(child_val) =
                    resolve_display_child_path(activation, this_obj, streaming_trimmed)?
                {
                    let prop = AvmString::new_utf8(activation.gc(), "roomStreaming");
                    result_obj.set_dynamic_property(prop, child_val, activation.gc());
                    tracing::info!(
                        "[localgobe-room-compat] room={} field=roomStreaming entry='{}' resolved=true",
                        room_id,
                        streaming_trimmed
                    );
                } else {
                    tracing::warn!(
                        "[localgobe-room-compat] room={} field=roomStreaming entry='{}' resolved=false",
                        room_id,
                        streaming_trimmed
                    );
                }
            }
        }

        // 4. Primitive & Dictionary parameters (surpriseBox, maxUsers, vote, onTimerEffect)
        for &extra_key in &["surpriseBox", "maxUsers", "vote", "onTimerEffect"] {
            if let Some(extra_val) = json.get(extra_key) {
                let avm_val = json_value_to_avm2(activation, extra_val)?;
                let prop = AvmString::new_utf8(activation.gc(), extra_key);
                result_obj.set_dynamic_property(prop, avm_val, activation.gc());
            }
        }
    } else {
        tracing::info!(
            "[localgobe] Room {room_id} has no companion TXT: classified as ROOM_COMPAT_SWF_ONLY"
        );
    }

    Ok(result_obj.into())
}

pub fn is_mogobe_room_compat_candidate<'gc>(
    activation: &Activation<'_, 'gc>,
    name: AvmString<'gc>,
) -> bool {
    let is_compat_active = activation
        .context
        .root_swf
        .parameters()
        .iter()
        .any(|(k, v)| k == "roomCompatibility" && (v == "true" || v == "1"))
        || activation.context.root_swf.url().contains("roomCompatibility=true");
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

    parse_mogobe_room_definition(&name.to_utf8_lossy()).is_some()
}

pub fn parse_mogobe_room_definition(name_str: &str) -> Option<u32> {
    let id_str = if let Some(id) = name_str.strip_prefix("mlroom_") {
        id
    } else if let Some(id) = name_str.strip_prefix("mlRoom_") {
        id
    } else {
        return None;
    };

    if id_str.is_empty() || !id_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    id_str.parse().ok()
}

/// Matches room movie URLs strictly against the exact target room ID.
/// Prevents prefix collisions such as:
/// - room 500 matching room 50
/// - room 10064 / 10010 / 10017 matching room 100
/// - room 10100 matching room 101
pub fn is_room_movie_url(url: &str, target_room_id: u32) -> bool {
    let path = url.split('?').next().unwrap_or(url);
    let path = path.split('#').next().unwrap_or(path);
    let filename = path.rsplit('/').next().unwrap_or(path);
    if let Some(rest) = filename.strip_prefix("room_") {
        if let Some(id_str) = rest.strip_suffix(".swf") {
            if let Ok(id) = id_str.parse::<u32>() {
                return id == target_room_id;
            }
        }
    }
    false
}

pub fn resolve_mogobe_room_compat<'gc>(
    activation: &mut Activation<'_, 'gc>,
    appdomain: Domain<'gc>,
    name: AvmString<'gc>,
) -> Result<Option<ClassObject<'gc>>, Error<'gc>> {
    if !is_mogobe_room_compat_candidate(activation, name) {
        return Ok(None);
    }

    let name_str = name.to_utf8_lossy();
    let room_id = match parse_mogobe_room_definition(&name_str) {
        Some(id) => id,
        None => return Ok(None),
    };

    let name_qname = QName::new(activation.avm2().namespaces.public_all(), name);

    // If already exported in domain, return its class_object
    if let Some(existing_class) = appdomain.get_class(activation.context, &name_qname.into()) {
        if let Some(obj) = existing_class.class_object() {
            return Ok(Some(obj));
        }
    }

    // Find the room movie in library or fetch it
    let mut movie: Option<Arc<SwfMovie>> = None;
    for known in activation.context.library.known_movies() {
        if is_room_movie_url(known.url(), room_id) {
            movie = Some(known);
            break;
        }
    }

    let movie = if let Some(m) = movie {
        m
    } else {
        let asset_path = format!("/Swf/Rooms/room_{room_id}.swf?profile=20130526");
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
        match SwfMovie::from_data(&bytes, asset_url.clone(), None, None) {
            Ok(m) => Arc::new(m),
            Err(e) => {
                tracing::warn!("Failed to parse room movie {}: {}", asset_url, e);
                return Ok(None);
            }
        }
    };

    // Find symbol character ID placed with name mlRoom_<ID> or mlroom_<ID>
    let expected_names = [format!("mlRoom_{room_id}"), format!("mlroom_{room_id}")];
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
                        let name_trimmed = name_lossy.trim();
                        for exp in &expected_names {
                            if name_trimmed.eq_ignore_ascii_case(exp) {
                                if let PlaceObjectAction::Place(cid) | PlaceObjectAction::Replace(cid) = po.action {
                                    symbol_id = Some(cid);
                                    return Ok(ControlFlow::Exit);
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(ControlFlow::Continue)
    });

    // Fallback: search for DefineSprite placed on root or largest sprite
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

    // Ensure movie library exists and has domain set
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
        synthetic_mogobe_room_iinit,
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

    // Attach getSwfParams native method to prototype
    let get_swf_params_method = Method::synthetic_native(
        activation,
        super_init.translation_unit(),
        super_init.abc_method_index(),
        synthetic_mogobe_room_get_swf_params,
    );
    let fn_obj = FunctionObject::from_method(
        activation.context,
        get_swf_params_method,
        class_object.instance_scope(),
        None,
        Some(movieclip_cls_obj),
    );
    let prop_name = AvmString::new_utf8(activation.gc(), "getSwfParams");
    class_object
        .prototype()
        .set_dynamic_property(prop_name, fn_obj.into(), activation.gc());

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

    // Export both lowercase mlroom_<ID> and mixed-case mlRoom_<ID> aliases
    appdomain.export_class(name_qname, class, activation.gc());
    let stage_domain = activation.context.avm2.stage_domain();
    if stage_domain != appdomain {
        stage_domain.export_class(name_qname, class, activation.gc());
    }

    let alias_name = if name_str.starts_with("mlroom_") {
        format!("mlRoom_{room_id}")
    } else {
        format!("mlroom_{room_id}")
    };
    let alias_qname = QName::new(
        activation.avm2().namespaces.public_all(),
        AvmString::new_utf8(activation.gc(), alias_name),
    );
    appdomain.export_class(alias_qname, class, activation.gc());
    if stage_domain != appdomain {
        stage_domain.export_class(alias_qname, class, activation.gc());
    }

    tracing::info!(
        "[localgobe] Mogobe room compatibility resolved: room_id={}, requested={}, symbol_id={}, url={}",
        room_id, name_str, symbol_id, movie.url()
    );

    Ok(Some(class_object))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PlayerBuilder;
    use crate::avm2::activation::Activation as Avm2Activation;

    #[test]
    fn test_parse_mogobe_room_definition() {
        assert_eq!(parse_mogobe_room_definition("mlroom_20"), Some(20));
        assert_eq!(parse_mogobe_room_definition("mlRoom_60"), Some(60));
        assert_eq!(parse_mogobe_room_definition("mlroom_10017"), Some(10017));
        assert_eq!(parse_mogobe_room_definition("mlRoom_10100"), Some(10100));
        assert_eq!(parse_mogobe_room_definition("mlRoom_620"), Some(620));
        assert_eq!(parse_mogobe_room_definition("btnItem109"), None);
        assert_eq!(parse_mogobe_room_definition("invalid"), None);
    }

    #[test]
    fn test_is_room_movie_url_exact_and_collision_free() {
        // Room 50 vs Room 500
        assert!(is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_50.swf?appVer=20130526", 50));
        assert!(is_room_movie_url("/Swf/Rooms/room_50.swf?profile=20130526", 50));
        assert!(is_room_movie_url("room_50.swf", 50));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_500.swf?appVer=20130526", 50));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_5000.swf", 50));

        // Room 100 vs Room 10064 and other 100xx rooms
        assert!(is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_100.swf?appVer=20130526", 100));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10010.swf?appVer=20130526", 100));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10017.swf?appVer=20130526", 100));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10022.swf?appVer=20130526", 100));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10030.swf?appVer=20130526", 100));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10033.swf?appVer=20130526", 100));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10064.swf?appVer=20130526", 100));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10077.swf?appVer=20130526", 100));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10085.swf?appVer=20130526", 100));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10098.swf?appVer=20130526", 100));

        // Room 101 vs Room 101xx
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10100.swf", 101));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10101.swf", 101));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Rooms/room_10109.swf", 101));

        // Non-room movies
        assert!(!is_room_movie_url("http://127.0.0.1:5173/game/Swf/Mogo.swf", 50));
        assert!(!is_room_movie_url("http://127.0.0.1:5173/Swf/Assets/ControlPanel.swf", 20));
        assert!(!is_room_movie_url("invalid_url", 50));
    }

    #[test]
    fn test_mogobe_room_candidates() {
        let swf_bytes = include_bytes!("../../../../../../tests/tests/swfs/avm2/add/test.swf");
        let movie = SwfMovie::from_data(
            swf_bytes,
            "http://127.0.0.1:5173/game/Swf/Mogo.swf?profile=20130526&roomCompatibility=true".to_string(),
            None,
            None,
        )
        .expect("Failed to parse test SWF");

        let player = PlayerBuilder::new().with_movie(movie).build();
        player.lock().unwrap().mutate_with_update_context(|context| {
            let activation = Avm2Activation::from_nothing(context);

            let room_classes = ["mlroom_60", "mlRoom_60", "mlroom_10017", "mlRoom_10100", "mlRoom_620"];
            for class_name in room_classes {
                let name = AvmString::new_utf8(activation.gc(), class_name);
                assert!(
                    is_mogobe_room_compat_candidate(&activation, name),
                    "Should be room compat candidate: {}",
                    class_name
                );
            }

            // Negative candidates: Items or non-room definitions
            let non_candidates = ["btnItem109", "mlIconSItem109", "CustomClass", "mlroom_abc"];
            for class_name in non_candidates {
                let name = AvmString::new_utf8(activation.gc(), class_name);
                assert!(
                    !is_mogobe_room_compat_candidate(&activation, name),
                    "Should NOT be room compat candidate: {}",
                    class_name
                );
            }
        });
    }
}
