#!/usr/bin/env ruby
# Sets the App target's minimum iOS deployment to 16.0 (RoomPlan needs iOS 16+).
# Run from the repo root:  ruby set_ios16.rb
require 'xcodeproj'

proj_path = 'ios/App/App.xcodeproj'
abort("Can't find #{proj_path} — run from repo root.") unless File.exist?(proj_path)

project = Xcodeproj::Project.open(proj_path)
target = project.targets.find { |t| t.name == 'App' }
abort('No "App" target found.') unless target

target.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0'
  puts "✓ #{config.name}: IPHONEOS_DEPLOYMENT_TARGET = 16.0"
end

project.save
puts "Saved."
