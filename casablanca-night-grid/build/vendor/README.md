# Vendored libraries (minimal subset)

The packer (`build/pack_casablanca.py`) inlines exactly these files into the
built HTML — nothing else from either package is used, so nothing else is
vendored:

From **three@0.147.0** (MIT — see `package/LICENSE-three`):

    package/build/three.min.js
    package/examples/js/controls/OrbitControls.js
    package/examples/js/postprocessing/Pass.js
    package/examples/js/postprocessing/EffectComposer.js
    package/examples/js/postprocessing/RenderPass.js
    package/examples/js/postprocessing/ShaderPass.js
    package/examples/js/postprocessing/UnrealBloomPass.js
    package/examples/js/shaders/CopyShader.js
    package/examples/js/shaders/LuminosityHighPassShader.js

From **earcut@2.2.4** (ISC — see `package/LICENSE-earcut`):

    package/src/earcut.js

The layout mirrors both npm tarballs unpacked into the same `package/`
directory (which is what the packer's `VENDOR` path expects). To restore the
full packages instead:

    npm pack three@0.147.0 earcut@2.2.4
    tar xzf three-0.147.0.tgz -C build/vendor/
    tar xzf earcut-2.2.4.tgz -C build/vendor/   # merges into package/
