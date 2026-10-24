import Capacitor
import WebKit
import UIKit

/// CAPBridgeViewController subclass that enables swipe-from-left-edge
/// back navigation. Since Next.js SPA navigation doesn't create WKWebView
/// history entries, we use a UIScreenEdgePanGestureRecognizer to detect
/// the swipe and trigger JavaScript navigation instead.
class CustomViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.allowsBackForwardNavigationGestures = true

        // Add edge swipe gesture that triggers JS-based back navigation
        let edgePan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgeSwipe(_:)))
        edgePan.edges = .left
        webView?.addGestureRecognizer(edgePan)
    }

    @objc private func handleEdgeSwipe(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended else { return }
        // If WKWebView has real history, use it; otherwise trigger JS navigation
        if webView?.canGoBack == true {
            webView?.goBack()
        } else {
            webView?.evaluateJavaScript("""
                if (window.location.pathname.match(/^\\/dashboard\\/[^/]+$/)) {
                    window.location.href = '/dashboard/sessions';
                } else if (window.history.length > 1) {
                    window.history.back();
                }
            """, completionHandler: nil)
        }
    }
}
