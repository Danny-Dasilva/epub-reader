const { withMainApplication } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

/**
 * ONNX Runtime 1.24.3 ships a Gradle/Pod config plugin but its legacy
 * ReactPackage is not discovered by Expo's New Architecture autolinking.
 * Register it in generated MainApplication.kt while keeping android/ ignored.
 */
module.exports = function withOnnxruntimePackage(config) {
  return withMainApplication(config, (nextConfig) => {
    if (nextConfig.modResults.language !== 'kt') {
      throw new Error('Narrator expects a Kotlin MainApplication');
    }

    let contents = mergeContents({
      src: nextConfig.modResults.contents,
      newSrc: 'import ai.onnxruntime.reactnative.OnnxruntimePackage',
      tag: 'narrator-onnxruntime-import',
      anchor: /^package .*$/m,
      offset: 1,
      comment: '//',
    }).contents;

    contents = mergeContents({
      src: contents,
      newSrc: '          add(OnnxruntimePackage())',
      tag: 'narrator-onnxruntime-package',
      anchor: /PackageList\(this\)\.packages\.apply \{/,
      offset: 1,
      comment: '//',
    }).contents;

    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
