use serde::{Deserialize, Serialize};
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BaltoStatus {
    phase: String,
    stage: Option<String>,
    message: String,
    progress: u8,
    started_at: Option<String>,
    downloaded_gb: Option<f64>,
    download_total_gb: Option<f64>,
    download_rate_mbps: Option<f64>,
    eta_seconds: Option<u64>,
    gpu_name: Option<String>,
    gpu_memory_mib: Option<u64>,
    gpu_memory_used_mib: Option<u64>,
    docker_installed: bool,
    docker_ready: bool,
    tailscale_installed: bool,
    tailscale_signed_in: bool,
    tailscale_dns_name: Option<String>,
    remote_enabled: bool,
    remote_url: Option<String>,
    inference_ready: bool,
    workspace_ready: bool,
    warning: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    current_version: String,
    available_version: Option<String>,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| format!("Cannot resolve Balto data directory: {error}"))
}

fn resource_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|path| path.join("runtime"))
        .map_err(|error| format!("Cannot resolve Balto runtime resources: {error}"))
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("state.json"))
}

fn powershell_command(script: &Path, action: &str, app_data: &Path, resources: &Path) -> Command {
    let app_exe = std::env::current_exe().unwrap_or_default();
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg("-Action")
        .arg(action)
        .arg("-BaltoData")
        .arg(app_data)
        .arg("-Resources")
        .arg(resources)
        .arg("-AppExe")
        .arg(app_exe)
        .creation_flags(CREATE_NO_WINDOW);
    command
}

fn read_status(app: &AppHandle) -> Result<BaltoStatus, String> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(BaltoStatus {
            phase: "not-installed".into(),
            message: "Run the system check to begin.".into(),
            ..Default::default()
        });
    }
    let body = fs::read_to_string(&path)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    serde_json::from_str(&body).map_err(|error| format!("Invalid Balto state: {error}"))
}

#[tauri::command]
fn get_status(app: AppHandle) -> Result<BaltoStatus, String> {
    let app_data = app_data_dir(&app)?;
    fs::create_dir_all(&app_data)
        .map_err(|error| format!("Cannot create {}: {error}", app_data.display()))?;
    read_status(&app)
}

fn spawn_action(app: &AppHandle, action: &str) -> Result<(), String> {
    let app_data = app_data_dir(app)?;
    fs::create_dir_all(&app_data)
        .map_err(|error| format!("Cannot create {}: {error}", app_data.display()))?;
    let resources = resource_runtime_dir(app)?;
    let script = resources.join("balto.ps1");
    if !script.exists() {
        return Err(format!("Missing packaged runtime: {}", script.display()));
    }
    powershell_command(&script, action, &app_data, &resources)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not start Balto action '{action}': {error}"))
}

fn service_watchdog_pass(app: &AppHandle, recovery_armed: &mut bool) {
    let Ok(current) = read_status(app) else {
        return;
    };
    if matches!(current.phase.as_str(), "ready" | "degraded") {
        *recovery_armed = true;
    } else if matches!(
        current.phase.as_str(),
        "not-installed"
            | "installing"
            | "downloading-runtime"
            | "downloading-model"
            | "starting"
            | "stopping"
            | "stopped"
    ) {
        *recovery_armed = false;
    }

    let Ok(app_data) = app_data_dir(app) else {
        return;
    };
    let Ok(resources) = resource_runtime_dir(app) else {
        return;
    };
    let script = resources.join("balto.ps1");
    if !script.exists() {
        return;
    }

    let _ = powershell_command(&script, "status", &app_data, &resources)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    let Ok(refreshed) = read_status(app) else {
        return;
    };
    if refreshed.phase == "ready" {
        *recovery_armed = true;
        return;
    }
    if *recovery_armed && matches!(refreshed.phase.as_str(), "degraded" | "failed") {
        let _ = powershell_command(&script, "start", &app_data, &resources)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn run_service_watchdog(app: AppHandle) {
    thread::spawn(move || {
        let mut recovery_armed = false;
        loop {
            service_watchdog_pass(&app, &mut recovery_armed);
            thread::sleep(Duration::from_secs(5));
        }
    });
}

#[tauri::command]
fn setup_stack(app: AppHandle) -> Result<(), String> {
    spawn_action(&app, "setup")
}

#[tauri::command]
fn start_stack(app: AppHandle) -> Result<(), String> {
    spawn_action(&app, "start")
}

#[tauri::command]
fn stop_stack(app: AppHandle) -> Result<(), String> {
    spawn_action(&app, "stop")
}

#[tauri::command]
fn enable_remote(app: AppHandle) -> Result<(), String> {
    spawn_action(&app, "remote-on")
}

#[tauri::command]
fn disable_remote(app: AppHandle) -> Result<(), String> {
    spawn_action(&app, "remote-off")
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<UpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let available_version = app
        .updater()
        .map_err(|error| format!("Could not initialize updates: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?
        .map(|update| update.version);
    Ok(UpdateStatus {
        current_version,
        available_version,
    })
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| format!("Could not initialize updates: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?
        .ok_or_else(|| "Balto Speedrunner is already current.".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("The signed update could not be installed: {error}"))?;
    app.request_restart();
    Ok(())
}

#[tauri::command]
fn open_workspace(app: AppHandle, fresh: Option<bool>) -> Result<(), String> {
    if !read_status(&app)?.workspace_ready {
        return Err("Balto is still starting.".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Balto window is unavailable.".to_string())?;
    let workspace_url = if fresh.unwrap_or(false) {
        "http://127.0.0.1:3080/?balto=new"
    } else {
        "http://127.0.0.1:3080/"
    };
    window
        .navigate(workspace_url.parse().map_err(|_| "Invalid workspace URL")?)
        .map_err(|error| format!("Could not open the Balto workspace: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            run_service_watchdog(app.handle().clone());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_status,
            setup_stack,
            start_stack,
            stop_stack,
            enable_remote,
            disable_remote,
            check_for_updates,
            install_update,
            open_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running Balto Speedrunner");
}
