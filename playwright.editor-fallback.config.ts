import { defineConfig } from '@playwright/test';
import base from './playwright.editor-foundation.config.js';

export default defineConfig(base, {
  testMatch: 'map-navigation.spec.ts',
  grep: /invalid locator input|WebGL failure/,
});
