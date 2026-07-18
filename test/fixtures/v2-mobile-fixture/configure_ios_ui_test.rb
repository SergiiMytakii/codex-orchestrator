#!/usr/bin/env ruby

require 'fileutils'
require 'xcodeproj'

root = File.expand_path(ARGV.fetch(0))
project_path = File.join(root, 'ios', 'Runner.xcodeproj')
source_dir = File.join(root, 'ios', 'ProofUITests')
FileUtils.mkdir_p(source_dir)
source_path = File.join(source_dir, 'ProofUITests.swift')
File.write(source_path, <<~SWIFT)
  import Darwin
  import XCTest

  final class ProofUITests: XCTestCase {
    func testProofWorkflow() throws {
      let app = XCUIApplication()
      app.launch()
      let button = app.buttons["Activate proof"]
      XCTAssertTrue(button.waitForExistence(timeout: 20))
      print("CODEX_IOS_BEFORE_BEGIN")
      print(app.debugDescription)
      print("CODEX_IOS_BEFORE_END")
      button.tap()
      XCTAssertTrue(app.staticTexts["iOS proof ready"].waitForExistence(timeout: 20))
      print("CODEX_IOS_FINAL_BEGIN")
      print(app.debugDescription)
      print("CODEX_IOS_FINAL_END")
      print("CODEX_IOS_FINAL_READY")
      fflush(stdout)
      Thread.sleep(forTimeInterval: 30)
    }
  }
SWIFT

project = Xcodeproj::Project.open(project_path)
runner = project.targets.find { |target| target.name == 'Runner' } or abort('Runner target missing')
tests = project.targets.find { |target| target.name == 'ProofUITests' } ||
  project.new_target(:ui_test_bundle, 'ProofUITests', :ios, runner.deployment_target || '13.0')
tests.add_dependency(runner) unless tests.dependencies.any? { |dependency| dependency.target == runner }
tests.build_configurations.each do |configuration|
  configuration.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'dev.codex.proof.ProofUITests'
  configuration.build_settings['PRODUCT_NAME'] = 'ProofUITests'
  configuration.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  configuration.build_settings['SWIFT_VERSION'] = '5.0'
  configuration.build_settings['TEST_TARGET_NAME'] = 'Runner'
  configuration.build_settings['TARGETED_DEVICE_FAMILY'] = '1'
end
group = project.main_group.find_subpath('ProofUITests', true)
file = group.files.find { |candidate| candidate.real_path.to_s == source_path } || group.new_file(source_path)
tests.source_build_phase.add_file_reference(file) unless tests.source_build_phase.files_references.include?(file)
project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(runner)
scheme.set_launch_target(runner)
scheme.add_test_target(tests)
scheme.save_as(project_path, 'Proof')
