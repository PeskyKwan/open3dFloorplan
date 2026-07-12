#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the Swift plugin with Capacitor's JS bridge as "RoomPlan".
// Web side calls: window.Capacitor.Plugins.RoomPlan.scan()
CAP_PLUGIN(RoomPlanPlugin, "RoomPlan",
    CAP_PLUGIN_METHOD(scan, CAPPluginReturnPromise);
)
