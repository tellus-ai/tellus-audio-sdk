require 'cocoapods'
require 'xcodeproj'

# The application normally provides these React Native Podfile helpers.
def min_ios_version_supported = '15.1'
def install_modules_dependencies(_spec); end

spec = Pod::Specification.from_file('TellusAudioSdk.podspec')
accessor = Pod::Sandbox::FileAccessor.new(Pathname.pwd, spec.consumer(:ios))
name = 'TellusAudioSdkModels'
resources = accessor.resource_bundles.fetch(name)
project = Xcodeproj::Project.new('Resources.xcodeproj')
target = project.new_target(:bundle, name, :ios, '15.1')
target.add_resources(resources.map { |file| project.main_group.new_file(file) })
target.build_configurations.each do |config|
  config.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'ai.tellus.test.resources'
end
project.save
