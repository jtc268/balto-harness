#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = balto_speedrunner_lib::run_hidden_launcher_if_requested() {
        std::process::exit(exit_code);
    }
    balto_speedrunner_lib::run();
}
