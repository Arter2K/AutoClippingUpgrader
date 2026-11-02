# Third-party components

AutoClippingUpgrader uses Electron (MIT); Electron's own license and Chromium third-party notices are included alongside the application executable.

FFmpeg and FFprobe are separate child-process executables supplied by the Gyan.dev Windows essentials build, version 9.0.2. This build is GPL v3, including libx264/libx265 support. The original license and build configuration are included as FFmpeg-GPLv3.txt and FFmpeg-build-info.txt in this directory.

Binary provider: https://www.gyan.dev/ffmpeg/builds/
FFmpeg project: https://ffmpeg.org/
FFmpeg source revision recorded by this build: https://github.com/FFmpeg/FFmpeg/commit/946fcce07b

This is a local application build, not a public release. Any public distribution must provide the corresponding FFmpeg build sources and notices as required by the component licenses; a source revision link alone is not a substitute for a corresponding-source distribution.

Bundled JavaScript libraries include React/React DOM, Zustand, Framer Motion, Lucide, Radix Slot, class-variance-authority, clsx, tailwind-merge (MIT), and Zod (MIT). Their license texts are collected in JavaScript-LICENSES.txt during packaging.

Rich text uses fontkit (MIT). Local image background removal uses @imgly/background-removal 1.7.0 (AGPL-3.0) and ONNX Runtime Web (MIT). The quantized ISNET model and WASM assets come from the official @imgly/background-removal-data 1.7.0 package. Its license and third-party model/runtime attribution are included in resources/ai-assets/LICENSE.md and ThirdPartyLicenses.json; the library and runtime license texts are included in JavaScript-LICENSES.txt. Upstream sources: https://github.com/imgly/background-removal-js and https://github.com/microsoft/onnxruntime .

The IMG.LY component has copyleft licensing. Public distribution requires meeting its corresponding-source/license obligations or obtaining an appropriate commercial license. User images are processed locally; this build serves model assets from the application resources without contacting a model CDN at runtime.
