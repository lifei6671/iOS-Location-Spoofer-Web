/**
 * Copyright (c) 2026 akudamatata (https://github.com/akudamatata/iOS-Location-Spoofer-Web)
 * Licensed under CC BY-NC-SA 4.0
 * 本项目免费开源，严禁二次售卖。
 */
import { renderPlugin } from './_plugin.js';

export async function onRequestGet(context) {
  return renderPlugin(context);
}
