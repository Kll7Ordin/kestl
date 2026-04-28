// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Disable DMA-BUF renderer before WebKit initializes — prevents EGL_NOT_INITIALIZED
  // crash on Linux systems where the GBM EGL display cannot be created.
  #[cfg(target_os = "linux")]
  std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

  app_lib::run();
}
