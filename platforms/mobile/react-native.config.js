module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: {
        packageImportPath: 'import com.margelo.nitro.tellus.TellusAudioSdkPackage;',
        packageInstance: 'new TellusAudioSdkPackage()',
      },
    },
  },
};
