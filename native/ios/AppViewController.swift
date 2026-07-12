import UIKit
import Capacitor

/// Custom bridge view controller — the ONLY reliable way to register an
/// app-local plugin in Capacitor 6+ (`packageClassList` in capacitor.config
/// gets overwritten by the CLI on every `cap sync`).
/// Main.storyboard's view controller class points here.
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(RoomPlanPlugin())
    }
}
