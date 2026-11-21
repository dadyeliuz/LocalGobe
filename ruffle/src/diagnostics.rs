use crate::avm2::object::TObject;
use crate::context::UpdateContext;
use crate::display_object::{DisplayObject, TDisplayObject};
use crate::prelude::TDisplayObjectContainer;
use ruffle_render::filters::Filter;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub static ENTER_FRAME_ADDED: AtomicUsize = AtomicUsize::new(0);
pub static ENTER_FRAME_REMOVED: AtomicUsize = AtomicUsize::new(0);
pub static ENTER_FRAME_ACTIVE: AtomicUsize = AtomicUsize::new(0);

pub static TIMERS_CREATED: AtomicUsize = AtomicUsize::new(0);
pub static TIMERS_STARTED: AtomicUsize = AtomicUsize::new(0);
pub static TIMERS_STOPPED: AtomicUsize = AtomicUsize::new(0);

pub static AVM2_DURATIONS: Mutex<Vec<f64>> = Mutex::new(Vec::new());
pub static RENDER_DURATIONS: Mutex<Vec<f64>> = Mutex::new(Vec::new());
pub static AUDIO_DURATIONS: Mutex<Vec<f64>> = Mutex::new(Vec::new());
pub static TICK_INTERVALS: Mutex<Vec<f64>> = Mutex::new(Vec::new());

pub static LAST_LEVEL: Mutex<Option<String>> = Mutex::new(None);

pub fn record_avm2_duration(ms: f64) {
    if let Ok(mut v) = AVM2_DURATIONS.lock() {
        if v.len() >= 1000 {
            v.remove(0);
        }
        v.push(ms);
    }
}

pub fn record_render_duration(ms: f64) {
    if let Ok(mut v) = RENDER_DURATIONS.lock() {
        if v.len() >= 1000 {
            v.remove(0);
        }
        v.push(ms);
    }
}

pub fn record_audio_duration(ms: f64) {
    if let Ok(mut v) = AUDIO_DURATIONS.lock() {
        if v.len() >= 1000 {
            v.remove(0);
        }
        v.push(ms);
    }
}

pub fn record_tick_interval(ms: f64) {
    if let Ok(mut v) = TICK_INTERVALS.lock() {
        if v.len() >= 1000 {
            v.remove(0);
        }
        v.push(ms);
    }
}

fn calc_stats(mut values: Vec<f64>) -> (f64, f64, f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let sum: f64 = values.iter().sum();
    let avg = sum / values.len() as f64;
    let p50 = values[values.len() / 2];
    let p95 = values[(values.len() as f64 * 0.95) as usize];
    let worst = *values.last().unwrap_or(&0.0);
    (avg, p50, p95, worst)
}

pub fn take_display_census_json<'gc>(context: &mut UpdateContext<'gc>) -> String {
    let mut total = 0usize;
    let mut movie_clips = 0usize;
    let mut sprites = 0usize;
    let mut shapes = 0usize;
    let mut bitmaps = 0usize;
    let mut text_fields = 0usize;
    let mut visible = 0usize;
    let mut invisible = 0usize;
    let mut alpha_zero = 0usize;
    let mut masks = 0usize;
    let mut cache_as_bitmap = 0usize;
    let mut total_filters = 0usize;
    let mut drop_shadow_filters = 0usize;
    let mut blur_filters = 0usize;
    let mut glow_filters = 0usize;
    let mut color_matrix_filters = 0usize;
    let mut filter_details = Vec::new();

    let mut class_counts: HashMap<String, usize> = HashMap::new();
    let mut detected_level: Option<String> = None;

    fn recurse<'gc>(
        dobj: DisplayObject<'gc>,
        context: &UpdateContext<'gc>,
        total: &mut usize,
        movie_clips: &mut usize,
        sprites: &mut usize,
        shapes: &mut usize,
        bitmaps: &mut usize,
        text_fields: &mut usize,
        visible: &mut usize,
        invisible: &mut usize,
        alpha_zero: &mut usize,
        masks: &mut usize,
        cache_as_bitmap: &mut usize,
        total_filters: &mut usize,
        drop_shadow_filters: &mut usize,
        blur_filters: &mut usize,
        glow_filters: &mut usize,
        color_matrix_filters: &mut usize,
        filter_details: &mut Vec<serde_json::Value>,
        class_counts: &mut HashMap<String, usize>,
        detected_level: &mut Option<String>,
    ) {
        *total += 1;
        match dobj {
            DisplayObject::MovieClip(_) => *movie_clips += 1,
            DisplayObject::Graphic(_) | DisplayObject::MorphShape(_) => *shapes += 1,
            DisplayObject::Bitmap(_) => *bitmaps += 1,
            DisplayObject::EditText(et) => {
                *text_fields += 1;
                let text = et.text().to_string();
                if let Some(name) = dobj.name() {
                    if name.to_string() == "txtLevel" {
                        *detected_level = Some(text);
                    }
                }
            }
            DisplayObject::Text(_) | DisplayObject::TextLine(_) => *text_fields += 1,
            _ => {
                if dobj.as_container().is_some() {
                    *sprites += 1;
                }
            }
        }

        if dobj.visible() {
            *visible += 1;
        } else {
            *invisible += 1;
        }
        if dobj.alpha() == 0.0 {
            *alpha_zero += 1;
        }
        if dobj.maskee().is_some() {
            *masks += 1;
        }
        if dobj.is_bitmap_cached_preference() {
            *cache_as_bitmap += 1;
        }

        let filters = dobj.filters();
        *total_filters += filters.len();
        for f in filters.iter() {
            let obj_name = dobj
                .name()
                .map(|n| n.to_string())
                .unwrap_or_else(|| "unnamed".to_string());
            match f {
                Filter::DropShadowFilter(ds) => {
                    *drop_shadow_filters += 1;
                    filter_details.push(json!({
                        "type": "DropShadowFilter",
                        "target": obj_name,
                        "blur_x": ds.blur_x.to_f32(),
                        "blur_y": ds.blur_y.to_f32(),
                        "passes": ds.num_passes(),
                        "distance": ds.distance.to_f32(),
                    }));
                }
                Filter::BlurFilter(b) => {
                    *blur_filters += 1;
                    filter_details.push(json!({
                        "type": "BlurFilter",
                        "target": obj_name,
                        "blur_x": b.blur_x.to_f32(),
                        "blur_y": b.blur_y.to_f32(),
                        "passes": b.num_passes(),
                    }));
                }
                Filter::GlowFilter(g) => {
                    *glow_filters += 1;
                    filter_details.push(json!({
                        "type": "GlowFilter",
                        "target": obj_name,
                        "blur_x": g.blur_x.to_f32(),
                        "blur_y": g.blur_y.to_f32(),
                        "passes": g.num_passes(),
                    }));
                }
                Filter::ColorMatrixFilter(_) => {
                    *color_matrix_filters += 1;
                }
                _ => {}
            }
        }

        if let Some(obj) = dobj.object2() {
            let class_name = obj.instance_of_class_name(context.gc()).to_string();
            *class_counts.entry(class_name).or_insert(0) += 1;
        }

        if let Some(container) = dobj.as_container() {
            for child in container.iter_render_list() {
                recurse(
                    child,
                    context,
                    total,
                    movie_clips,
                    sprites,
                    shapes,
                    bitmaps,
                    text_fields,
                    visible,
                    invisible,
                    alpha_zero,
                    masks,
                    cache_as_bitmap,
                    total_filters,
                    drop_shadow_filters,
                    blur_filters,
                    glow_filters,
                    color_matrix_filters,
                    filter_details,
                    class_counts,
                    detected_level,
                );
            }
        }
    }

    recurse(
        context.stage.into(),
        context,
        &mut total,
        &mut movie_clips,
        &mut sprites,
        &mut shapes,
        &mut bitmaps,
        &mut text_fields,
        &mut visible,
        &mut invisible,
        &mut alpha_zero,
        &mut masks,
        &mut cache_as_bitmap,
        &mut total_filters,
        &mut drop_shadow_filters,
        &mut blur_filters,
        &mut glow_filters,
        &mut color_matrix_filters,
        &mut filter_details,
        &mut class_counts,
        &mut detected_level,
    );

    // Level change detection
    if let Some(ref lvl) = detected_level {
        let mut last = LAST_LEVEL.lock().unwrap();
        if last.as_ref() != Some(lvl) {
            tracing::info!(
                "[LOCALGOBE_CHECKPOINT:LEVEL_CHANGE] from={:?} to={:?} timestamp={:?}",
                last.as_ref(),
                lvl,
                web_time::Instant::now()
            );
            *last = Some(lvl.clone());
        }
    }

    // Sort classes by count descending
    let mut top_classes: Vec<(String, usize)> = class_counts.into_iter().collect();
    top_classes.sort_by(|a, b| b.1.cmp(&a.1));
    top_classes.truncate(20);

    // Orphan count & classes
    let orphan_total = context.orphan_manager.orphans().len();
    let mut orphan_classes: HashMap<String, usize> = HashMap::new();
    for weak in context.orphan_manager.orphans() {
        if let Some(dobj) = weak.upgrade(context.gc()) {
            if let Some(obj) = dobj.object2() {
                let name = obj.instance_of_class_name(context.gc()).to_string();
                *orphan_classes.entry(name).or_insert(0) += 1;
            }
        }
    }
    let mut top_orphan_classes: Vec<(String, usize)> = orphan_classes.into_iter().collect();
    top_orphan_classes.sort_by(|a, b| b.1.cmp(&a.1));

    // Timings
    let avm2_stats = calc_stats(AVM2_DURATIONS.lock().map(|v| v.clone()).unwrap_or_default());
    let render_stats = calc_stats(RENDER_DURATIONS.lock().map(|v| v.clone()).unwrap_or_default());
    let audio_stats = calc_stats(AUDIO_DURATIONS.lock().map(|v| v.clone()).unwrap_or_default());
    let tick_stats = calc_stats(TICK_INTERVALS.lock().map(|v| v.clone()).unwrap_or_default());

    let payload = json!({
        "detected_level": detected_level,
        "stage_quality": format!("{:?}", context.stage.quality()),
        "display_objects": {
            "total": total,
            "movie_clips": movie_clips,
            "sprites": sprites,
            "shapes": shapes,
            "bitmaps": bitmaps,
            "text_fields": text_fields,
            "visible": visible,
            "invisible": invisible,
            "alpha_zero": alpha_zero,
            "masks": masks,
            "cache_as_bitmap": cache_as_bitmap,
        },
        "filters": {
            "total": total_filters,
            "drop_shadow": drop_shadow_filters,
            "blur": blur_filters,
            "glow": glow_filters,
            "color_matrix": color_matrix_filters,
            "samples": filter_details.into_iter().take(10).collect::<Vec<_>>(),
        },
        "top_classes": top_classes,
        "orphans": {
            "total": orphan_total,
            "classes": top_orphan_classes,
        },
        "timers": {
            "active": context.timers.len(),
            "created": TIMERS_CREATED.load(Ordering::Relaxed),
            "started": TIMERS_STARTED.load(Ordering::Relaxed),
            "stopped": TIMERS_STOPPED.load(Ordering::Relaxed),
        },
        "enter_frame": {
            "active": ENTER_FRAME_ACTIVE.load(Ordering::Relaxed),
            "added": ENTER_FRAME_ADDED.load(Ordering::Relaxed),
            "removed": ENTER_FRAME_REMOVED.load(Ordering::Relaxed),
        },
        "sounds": {
            "active": context.audio_manager.num_active_sounds(),
        },
        "timings_ms": {
            "avm2": { "avg": avm2_stats.0, "p50": avm2_stats.1, "p95": avm2_stats.2, "worst": avm2_stats.3 },
            "render": { "avg": render_stats.0, "p50": render_stats.1, "p95": render_stats.2, "worst": render_stats.3 },
            "audio": { "avg": audio_stats.0, "p50": audio_stats.1, "p95": audio_stats.2, "worst": audio_stats.3 },
            "tick": { "avg": tick_stats.0, "p50": tick_stats.1, "p95": tick_stats.2, "worst": tick_stats.3 },
        }
    });

    let s = serde_json::to_string(&payload).unwrap_or_default();
    s
}

pub fn call_game_method<'gc>(
    context: &mut UpdateContext<'gc>,
    method_name: &str,
    target_level: Option<f64>,
) -> Result<String, String> {
    fn find_game<'gc>(
        dobj: DisplayObject<'gc>,
        context: &UpdateContext<'gc>,
    ) -> Option<crate::avm2::Object<'gc>> {
        if let Some(obj) = dobj.object2() {
            let class_name = obj.instance_of_class_name(context.gc()).to_string();
            if class_name.contains("spider::Game") {
                return Some(obj.into());
            }
        }
        if let Some(container) = dobj.as_container() {
            for child in container.iter_render_list() {
                if let Some(res) = find_game(child, context) {
                    return Some(res);
                }
            }
        }
        None
    }

    let Some(game_obj) = find_game(context.stage.into(), context) else {
        return Err("Game object not found on stage".to_string());
    };

    let domain = context.avm2.stage_domain();
    let mut activation = crate::avm2::Activation::from_domain(context, domain);
    let vtable = game_obj.vtable();

    let mut found_disp = None;
    for (name, _ns, prop) in vtable.resolved_traits().iter() {
        if *name == *method_name.as_bytes() {
            if let crate::avm2::property::Property::Method { disp_id } = prop {
                found_disp = Some(*disp_id);
                break;
            }
        }
    }

    if let Some(disp_id) = found_disp {
        let args: Vec<crate::avm2::Value<'gc>> = if let Some(lvl) = target_level {
            vec![crate::avm2::Value::Number(lvl)]
        } else {
            vec![]
        };
        let game_val = crate::avm2::Value::from(game_obj);
        let res = game_val
            .call_method_with_args(
                disp_id,
                crate::avm2::FunctionArgs::from_slice(&args),
                &mut activation,
            )
            .map_err(|e| format!("Method exec error: {:?}", e))?;
        Ok(format!("Executed {}: {:?}", method_name, res))
    } else {
        Err(format!("Method {} trait not found in vtable", method_name))
    }
}
