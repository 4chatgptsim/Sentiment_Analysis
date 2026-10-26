# Third-party components

Snap Vanish bundles the following components. All of them run locally in
your browser; nothing is downloaded at run time.

| Component | Files | Licence |
|---|---|---|
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) 1.1.1 (Google) | `vendor/mediapipe/*` | Apache License 2.0 |
| [MediaPipe Hand Landmarker model](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) (float16) | `models/hand_landmarker.task` | Apache License 2.0 |
| [MediaPipe Selfie Segmenter (landscape)](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) (float16) | `models/selfie_segmenter_landscape.tflite` | Apache License 2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.30.0 (Microsoft), WebAssembly build | `vendor/ort/*` | MIT License |
| [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) 512 Places2 ONNX pipeline (Picsart AI Research) | `models/migan_pipeline_v2.onnx` | MIT License (code and weights) |

Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0

MIT License (ONNX Runtime): Copyright (c) Microsoft Corporation.
MIT License (MI-GAN): Copyright (c) 2024 Picsart AI Research (PAIR).

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
