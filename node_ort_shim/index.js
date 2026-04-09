// Shim: redirect onnxruntime-node → onnxruntime-web (WASM backend)
// This avoids native binary issues (e.g. missing VC++ runtime on Windows)
// while keeping full API compatibility with @xenova/transformers.
//
// @xenova/transformers uses:
//   import * as ONNX_NODE from 'onnxruntime-node';
//   ONNX = ONNX_NODE.default ?? ONNX_NODE;
//
// By redirecting to onnxruntime-web, the WASM backend is used transparently.

const ort = require('onnxruntime-web');
module.exports = ort;
