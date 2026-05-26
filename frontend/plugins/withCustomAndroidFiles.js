const { withProjectBuildGradle, withAppBuildGradle, withMainApplication, withMainActivity } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Config plugin to restore custom Android files after regeneration
 * This copies your custom files from backup to the regenerated android folder
 */
const withCustomAndroidFiles = (config) => {
  // Path to your backed-up custom files
  const customFilesBackup = path.join(__dirname, 'backup');
  const androidTarget = path.join(config.modRequest.projectRoot, 'android');
  
  // Function to copy custom files if they exist in backup
  const restoreCustomFiles = () => {
    if (!fs.existsSync(customFilesBackup)) {
      console.log('No custom files backup found, skipping restore');
      return;
    }
    
    // Example: Copy custom Java/Kotlin files
    const javaBackup = path.join(customFilesBackup, 'java');
    const javaTarget = path.join(androidTarget, 'app/src/main/java');
    
    if (fs.existsSync(javaBackup)) {
      fs.cpSync(javaBackup, javaTarget, { recursive: true, force: true });
      console.log('✅ Restored custom Java/Kotlin files');
    }
    
    // Example: Copy custom resources
    const resBackup = path.join(customFilesBackup, 'res');
    const resTarget = path.join(androidTarget, 'app/src/main/res');
    
    if (fs.existsSync(resBackup)) {
      fs.cpSync(resBackup, resTarget, { recursive: true, force: true });
      console.log('✅ Restored custom resource files');
    }
  };
  
  // Hook into the prebuild process
  config = withMainApplication(config, (modConfig) => {
    restoreCustomFiles();
    return modConfig;
  });
  
  return config;
};

module.exports = withCustomAndroidFiles;
