import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { installPointerDragShim, needsPointerDragShim } from './lib/dnd/pointerDragShim';

// WebKitGTK inside JUCE cannot complete a native drop; see pointerDragShim.ts.
if (needsPointerDragShim(navigator.userAgent)) installPointerDragShim();

export default mount(App, { target: document.getElementById('app')! });
