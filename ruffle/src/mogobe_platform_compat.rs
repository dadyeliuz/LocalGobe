//! LocalGobe Mogobe Platform Compatibility Resolver
//!
//! Provides minimal, scoped AVM2 compatibility for `mogobe.PlatformClasses`
//! consumed by `ExternalGameManager` in legacy Mogobe builds (Spring 2013).

use crate::avm2::activation::Activation;
use crate::avm2::class::Class;
use crate::avm2::error::Error;
use crate::avm2::function::FunctionArgs;
use crate::avm2::method::MethodAssociation;
use crate::avm2::object::{ClassObject, FunctionObject, ScriptObject, TObject};
use crate::avm2::traits::Trait;
use crate::avm2::value::Value;
use crate::avm2::{ApiVersion, Domain, Method, Multiname, Namespace, QName};
use crate::string::AvmString;
use ruffle_wstr::WStr;

pub fn is_mogobe_platform_compat_name_str(name_str: &str) -> bool {
    name_str == "mogobe.PlatformClasses" || name_str == "mogobe::PlatformClasses"
}

pub fn is_mogobe_platform_compat_candidate<'gc>(
    activation: &Activation<'_, 'gc>,
    name: &Multiname<'gc>,
) -> bool {
    // 1. Strict exact QName check: PackageNamespace("mogobe"), local_name "PlatformClasses"
    // Never match wildcards (*.PlatformClasses, mogobe.*)
    if name.is_any_name() || name.is_any_namespace() {
        return false;
    }

    let is_exact_name = name
        .local_name()
        .map(|n| n.as_wstr() == WStr::from_units(b"PlatformClasses"))
        .unwrap_or(false);
    if !is_exact_name {
        return false;
    }

    let has_mogobe_ns = name
        .namespace_set()
        .iter()
        .any(|ns| !ns.is_any() && ns.as_uri_opt().map(|uri| uri.as_wstr() == WStr::from_units(b"mogobe")).unwrap_or(false));
    if !has_mogobe_ns {
        return false;
    }

    // 2. Strict caller movie check: must be ExternalGameManager
    let movie = activation.caller_movie_or_root();
    movie.url().contains("ExternalGameManager")
}

pub fn is_mogobe_platform_compat_candidate_str<'gc>(
    activation: &Activation<'_, 'gc>,
    name: AvmString<'gc>,
) -> bool {
    if !is_mogobe_platform_compat_name_str(&name.to_utf8_lossy()) {
        return false;
    }
    let movie = activation.caller_movie_or_root();
    movie.url().contains("ExternalGameManager")
}

pub fn synthetic_mogobe_platform_iinit<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Value<'gc>,
    _args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    activation.super_init(this, FunctionArgs::empty())?;
    Ok(Value::Undefined)
}

pub fn synthetic_mogobe_platform_get_instance<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Value<'gc>,
    _args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let instance_prop = AvmString::new_utf8(activation.gc(), "_instance");
    if let Some(this_obj) = this.as_object() {
        if let Some(instance_val) = this_obj.get_dynamic_property(instance_prop) {
            if instance_val.as_object().is_some() {
                return Ok(instance_val);
            }
        }
    }

    // Construct singleton object with empty dynamic Games property
    let singleton = ScriptObject::new_object(activation.context);
    let games_prop = AvmString::new_utf8(activation.gc(), "Games");
    let games_obj = ScriptObject::new_object(activation.context);
    singleton.set_dynamic_property(games_prop, games_obj.into(), activation.gc());

    if let Some(this_obj) = this.as_object() {
        this_obj.set_dynamic_property(instance_prop, singleton.into(), activation.gc());
    }

    Ok(singleton.into())
}

pub fn resolve_mogobe_platform_compat<'gc>(
    activation: &mut Activation<'_, 'gc>,
    appdomain: Domain<'gc>,
    name: AvmString<'gc>,
) -> Result<Option<ClassObject<'gc>>, Error<'gc>> {
    let name_str = name.to_utf8_lossy();
    if !is_mogobe_platform_compat_name_str(&name_str) {
        return Ok(None);
    }
    let movie = activation.caller_movie_or_root();
    if !movie.url().contains("ExternalGameManager") {
        return Ok(None);
    }

    let pkg_name = AvmString::new_utf8(activation.gc(), "mogobe");
    let mogobe_ns = Namespace::package(
        pkg_name,
        ApiVersion::AllVersions,
        activation.strings(),
    );
    let name_qname = QName::new(
        mogobe_ns,
        AvmString::new_utf8(activation.gc(), "PlatformClasses"),
    );

    // Never override a real definition if already present in domain
    if let Some(existing_class) = appdomain.get_class(activation.context, &name_qname.into()) {
        if let Some(obj) = existing_class.class_object() {
            return Ok(Some(obj));
        }
    }

    let object_cls_obj = activation.avm2().classes().object;
    let super_class = object_cls_obj.inner_class_definition();
    let super_init = super_class
        .instance_init()
        .expect("Object must have instance_init");

    let synthetic_iinit = Method::synthetic_native(
        activation,
        super_init.translation_unit(),
        super_init.abc_method_index(),
        synthetic_mogobe_platform_iinit,
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
        MethodAssociation::classbound(class, Some(object_cls_obj), false),
    )?;

    let class_object = ClassObject::from_class_partial(
        activation,
        class,
        Some(object_cls_obj),
    );

    // Attach static method `getInstance`
    let get_instance_method = Method::synthetic_native(
        activation,
        super_init.translation_unit(),
        super_init.abc_method_index(),
        synthetic_mogobe_platform_get_instance,
    );
    let fn_obj = FunctionObject::from_method(
        activation.context,
        get_instance_method,
        class_object.instance_scope(),
        None,
        Some(object_cls_obj),
    );
    let get_instance_prop = AvmString::new_utf8(activation.gc(), "getInstance");
    class_object.set_dynamic_property(get_instance_prop, fn_obj.into(), activation.gc());

    // Export class into domain
    appdomain.export_class(name_qname, class, activation.gc());

    tracing::info!(
        "[localgobe] Provided synthetic mogobe.PlatformClasses compatibility class for ExternalGameManager"
    );

    Ok(Some(class_object))
}

pub fn resolve_mogobe_platform_scope<'gc>(
    activation: &mut Activation<'_, 'gc>,
    name: &Multiname<'gc>,
) -> Result<Option<Value<'gc>>, Error<'gc>> {
    if !is_mogobe_platform_compat_candidate(activation, name) {
        return Ok(None);
    }

    let appdomain = activation
        .caller_domain()
        .unwrap_or_else(|| activation.context.avm2.stage_domain());

    let def_name = AvmString::new_utf8(activation.gc(), "mogobe.PlatformClasses");
    let class_object = match resolve_mogobe_platform_compat(activation, appdomain, def_name)? {
        Some(co) => co,
        None => return Ok(None),
    };

    let scope_prop = AvmString::new_utf8(activation.gc(), "_scope");
    if let Some(existing_scope) = class_object.get_dynamic_property(scope_prop) {
        if existing_scope.as_object().is_some() {
            return Ok(Some(existing_scope));
        }
    }

    let mc = activation.gc();
    let scope_class_name = QName::new(
        activation.avm2().namespaces.public_all(),
        AvmString::new_utf8(mc, "PlatformCompatScope"),
    );
    let object_cls_obj = activation.avm2().classes().object;
    let super_class = object_cls_obj.inner_class_definition();

    let pkg_name = AvmString::new_utf8(mc, "mogobe");
    let mogobe_ns = Namespace::package(
        pkg_name,
        ApiVersion::AllVersions,
        activation.strings(),
    );
    let trait_qname = QName::new(mogobe_ns, AvmString::new_utf8(mc, "PlatformClasses"));
    let trait_ = Trait::new_slot(trait_qname, None);

    let scope_class = Class::custom_new(
        scope_class_name,
        Some(super_class),
        None,
        Box::new([trait_]),
        mc,
    );
    scope_class
        .init_vtable_with_interfaces(activation.context, Box::new([]))
        .map_err(|e| e.into_avm(activation))?;

    let vtable = scope_class.vtable();
    let scope_obj = ScriptObject::custom_object(mc, scope_class, None, vtable);
    scope_obj.set_slot(0, class_object.into(), activation)?;

    class_object.set_dynamic_property(scope_prop, scope_obj.into(), mc);

    Ok(Some(scope_obj.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PlayerBuilder;
    use crate::avm2::activation::Activation as Avm2Activation;
    use crate::tag_utils::SwfMovie;

    #[test]
    fn test_mogobe_platform_classes_compat() {
        let swf_bytes = include_bytes!("../../../../../../tests/tests/swfs/avm2/add/test.swf");
        let movie = SwfMovie::from_data(
            swf_bytes,
            "http://127.0.0.1:5173/Swf/Rooms/ExternalGameManager.swf?profile=20130526".to_string(),
            None,
            None,
        )
        .expect("Failed to parse test SWF");

        let player = PlayerBuilder::new().with_movie(movie).build();
        player.lock().unwrap().mutate_with_update_context(|context| {
            let mut activation = Avm2Activation::from_nothing(context);
            let appdomain = activation.context.avm2.stage_domain();

            let name = AvmString::new_utf8(activation.gc(), "mogobe.PlatformClasses");
            let cls_obj = resolve_mogobe_platform_compat(&mut activation, appdomain, name)
                .expect("resolve_mogobe_platform_compat should succeed")
                .expect("Class should be resolved");

            // 1. Verify getInstance returns singleton
            let get_instance_prop = Multiname::new(
                activation.avm2().namespaces.public_all(),
                AvmString::new_utf8(activation.gc(), "getInstance"),
            );
            let inst1 = Value::from(cls_obj)
                .call_property(&get_instance_prop, FunctionArgs::empty(), &mut activation)
                .expect("getInstance() call should succeed");
            let inst2 = Value::from(cls_obj)
                .call_property(&get_instance_prop, FunctionArgs::empty(), &mut activation)
                .expect("second getInstance() call should succeed");

            assert!(
                inst1.as_object().is_some() && inst1.as_object() == inst2.as_object(),
                "getInstance() must return the exact same singleton instance"
            );

            // 2. Verify Games property exists on singleton
            let games_prop = Multiname::new(
                activation.avm2().namespaces.public_all(),
                AvmString::new_utf8(activation.gc(), "Games"),
            );
            let games_val = inst1
                .get_property(&games_prop, &mut activation)
                .expect("inst.Games lookup should succeed");
            assert!(games_val.as_object().is_some(), "Games must be an object");

            // 3. Verify Games['LifeGuard'] is falsy (Value::Undefined)
            let lifeguard_prop = Multiname::new(
                activation.avm2().namespaces.public_all(),
                AvmString::new_utf8(activation.gc(), "LifeGuard"),
            );
            let lifeguard_val = games_val
                .get_property(&lifeguard_prop, &mut activation)
                .expect("Games['LifeGuard'] lookup should not error");
            assert!(
                matches!(lifeguard_val, Value::Undefined),
                "Unregistered game must be undefined/falsy"
            );

            // 4. Test resolve_mogobe_platform_scope
            let pkg_name = AvmString::new_utf8(activation.gc(), "mogobe");
            let mogobe_ns = Namespace::package(
                pkg_name,
                ApiVersion::AllVersions,
                activation.strings(),
            );
            let multiname = Multiname::new(
                mogobe_ns,
                AvmString::new_utf8(activation.gc(), "PlatformClasses"),
            );
            let scope_val = resolve_mogobe_platform_scope(&mut activation, &multiname)
                .expect("resolve_mogobe_platform_scope should succeed")
                .expect("Scope should be resolved");

            // Test get_property on scope object returns cls_obj
            let resolved_cls = scope_val
                .get_property(&multiname, &mut activation)
                .expect("Scope get_property should succeed");
            assert_eq!(
                resolved_cls.as_object(),
                Some(cls_obj.into()),
                "Scope must return PlatformClasses ClassObject"
            );
        });
    }

    #[test]
    fn test_unrelated_swf_does_not_resolve_platform_classes() {
        let swf_bytes = include_bytes!("../../../../../../tests/tests/swfs/avm2/add/test.swf");
        let movie = SwfMovie::from_data(
            swf_bytes,
            "http://127.0.0.1:5173/Swf/Main.swf".to_string(),
            None,
            None,
        )
        .expect("Failed to parse test SWF");

        let player = PlayerBuilder::new().with_movie(movie).build();
        player.lock().unwrap().mutate_with_update_context(|context| {
            let mut activation = Avm2Activation::from_nothing(context);
            let appdomain = activation.context.avm2.stage_domain();

            let name = AvmString::new_utf8(activation.gc(), "mogobe.PlatformClasses");
            let result = resolve_mogobe_platform_compat(&mut activation, appdomain, name)
                .expect("should not error");
            assert!(result.is_none(), "Unrelated SWF must NOT resolve compatibility class");

            let pkg_name = AvmString::new_utf8(activation.gc(), "mogobe");
            let mogobe_ns = Namespace::package(
                pkg_name,
                ApiVersion::AllVersions,
                activation.strings(),
            );
            let multiname = Multiname::new(
                mogobe_ns,
                AvmString::new_utf8(activation.gc(), "PlatformClasses"),
            );
            assert!(
                !is_mogobe_platform_compat_candidate(&activation, &multiname),
                "Unrelated SWF must not be a compat candidate"
            );
        });
    }

    #[test]
    fn test_wildcard_or_wrong_name_not_matched() {
        let swf_bytes = include_bytes!("../../../../../../tests/tests/swfs/avm2/add/test.swf");
        let movie = SwfMovie::from_data(
            swf_bytes,
            "http://127.0.0.1:5173/Swf/Rooms/ExternalGameManager.swf".to_string(),
            None,
            None,
        )
        .expect("Failed to parse test SWF");

        let player = PlayerBuilder::new().with_movie(movie).build();
        player.lock().unwrap().mutate_with_update_context(|context| {
            let mut activation = Avm2Activation::from_nothing(context);

            // Wrong name
            let pkg_name = AvmString::new_utf8(activation.gc(), "mogobe");
            let mogobe_ns = Namespace::package(
                pkg_name,
                ApiVersion::AllVersions,
                activation.strings(),
            );
            let wrong_name = Multiname::new(
                mogobe_ns,
                AvmString::new_utf8(activation.gc(), "PlatformClass"),
            );
            assert!(!is_mogobe_platform_compat_candidate(&activation, &wrong_name));

            // Public namespace instead of mogobe
            let public_name = Multiname::new(
                activation.avm2().namespaces.public_all(),
                AvmString::new_utf8(activation.gc(), "PlatformClasses"),
            );
            assert!(!is_mogobe_platform_compat_candidate(&activation, &public_name));

            // Wildcard namespace (*.PlatformClasses)
            let any_ns_name = Multiname::new(
                Namespace::any(),
                AvmString::new_utf8(activation.gc(), "PlatformClasses"),
            );
            assert!(!is_mogobe_platform_compat_candidate(&activation, &any_ns_name));
        });
    }

    #[test]
    fn test_existing_real_platform_classes_is_not_overridden() {
        let swf_bytes = include_bytes!("../../../../../../tests/tests/swfs/avm2/add/test.swf");
        let movie = SwfMovie::from_data(
            swf_bytes,
            "http://127.0.0.1:5173/Swf/Rooms/ExternalGameManager.swf?profile=20130526".to_string(),
            None,
            None,
        )
        .expect("Failed to parse test SWF");

        let player = PlayerBuilder::new().with_movie(movie).build();
        player.lock().unwrap().mutate_with_update_context(|context| {
            let mut activation = Avm2Activation::from_nothing(context);
            let appdomain = activation.context.avm2.stage_domain();

            let pkg_name = AvmString::new_utf8(activation.gc(), "mogobe");
            let mogobe_ns = Namespace::package(
                pkg_name,
                ApiVersion::AllVersions,
                activation.strings(),
            );
            let name_qname = QName::new(
                mogobe_ns,
                AvmString::new_utf8(activation.gc(), "PlatformClasses"),
            );

            // Create a "real" class with a distinct marker property
            let object_cls_obj = activation.avm2().classes().object;
            let super_class = object_cls_obj.inner_class_definition();
            let real_class = Class::custom_subclass(
                activation.context,
                name_qname,
                super_class,
                super_class.instance_init(),
            )
            .unwrap();
            let real_class_object = ClassObject::from_class_partial(
                &mut activation,
                real_class,
                Some(object_cls_obj),
            );
            let marker = AvmString::new_utf8(activation.gc(), "isReal");
            real_class_object.set_dynamic_property(marker, Value::Bool(true), activation.gc());
            appdomain.export_class(name_qname, real_class, activation.gc());

            // Now call resolve_mogobe_platform_compat
            let name = AvmString::new_utf8(activation.gc(), "mogobe.PlatformClasses");
            let resolved = resolve_mogobe_platform_compat(&mut activation, appdomain, name)
                .expect("should not error")
                .expect("class should be found");

            assert_eq!(resolved, real_class_object, "Must return existing real class, not synthetic replacement");
            assert!(
                matches!(resolved.get_dynamic_property(marker), Some(Value::Bool(true))),
                "Real class dynamic properties must be preserved"
            );
        });
    }
}
