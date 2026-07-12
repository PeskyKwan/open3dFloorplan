import Foundation
import Capacitor
import RoomPlan

/// Capacitor plugin exposing Apple RoomPlan (LiDAR) to the web editor.
/// Web calls: window.Capacitor.Plugins.RoomPlan.scan() -> { json } | { cancelled: true }
///
/// The JSON is `JSONEncoder().encode(CapturedRoom)` — the SAME format the OpenPlan3D
/// web importer (roomplanImport.ts) already reads, so no format translation is needed.
@objc(RoomPlanPlugin)
public class RoomPlanPlugin: CAPPlugin, CAPBridgedPlugin {
    // CAPBridgedPlugin conformance (Capacitor 6+ registration metadata).
    public let identifier = "RoomPlanPlugin"
    public let jsName = "RoomPlan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?

    @objc func scan(_ call: CAPPluginCall) {
        guard RoomCaptureSession.isSupported else {
            call.reject("This device has no LiDAR / RoomPlan support (需要有 LiDAR 嘅 iPhone/iPad).")
            return
        }
        self.pendingCall = call
        DispatchQueue.main.async {
            let vc = RoomScanViewController()
            vc.onFinish = { [weak self] json in
                self?.pendingCall?.resolve(["json": json])
                self?.pendingCall = nil
            }
            vc.onCancel = { [weak self] in
                self?.pendingCall?.resolve(["cancelled": true])
                self?.pendingCall = nil
            }
            vc.modalPresentationStyle = .fullScreen
            self.bridge?.viewController?.present(vc, animated: true)
        }
    }
}
