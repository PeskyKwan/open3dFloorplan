#!/usr/bin/env ruby
# Adds the RoomPlan plugin source files to the Capacitor "App" iOS target.
# Run from the repo root:  ruby add_roomplan_files.rb
require 'xcodeproj'

proj_path = 'ios/App/App.xcodeproj'
abort("Can't find #{proj_path} — run this from the repo root.") unless File.exist?(proj_path)

project = Xcodeproj::Project.open(proj_path)
target = project.targets.find { |t| t.name == 'App' }
abort('No "App" target found.') unless target

# The "App" group maps to ios/App/App/ where we copied the files.
app_group = project.main_group['App'] || project.main_group
files = ['RoomPlanPlugin.swift', 'RoomPlanPlugin.m', 'RoomScanViewController.swift']

files.each do |name|
  already = target.source_build_phase.files.any? { |bf| bf.file_ref && bf.file_ref.path && bf.file_ref.path.end_with?(name) }
  if already
    puts "• #{name} already in target — skip"
    next
  end
  ref = app_group.new_reference(name)   # path relative to the App group (ios/App/App)
  target.add_file_references([ref])
  puts "✓ added #{name}"
end

project.save
puts "\nSaved. Compile Sources now:"
target.source_build_phase.files.each { |bf| puts "   #{bf.file_ref&.path}" }
