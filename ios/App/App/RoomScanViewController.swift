import UIKit
import RoomPlan

/// Full-screen RoomPlan capture screen (adapted from HomeScanner's RoomScannerView).
/// On "Done" it encodes the CapturedRoom to JSON and calls `onFinish(json)`.
/// On "✕" it calls `onCancel()`. Either way it dismisses itself.
final class RoomScanViewController: UIViewController, RoomCaptureViewDelegate {

    var onFinish: ((String) -> Void)?
    var onCancel: (() -> Void)?

    private var roomCaptureView: RoomCaptureView!
    private let configuration = RoomCaptureSession.Configuration()

    private let doneButton = UIButton(type: .system)
    private let closeButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupCaptureView()
        setupButtons()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        roomCaptureView?.captureSession.run(configuration: configuration)
    }

    private func setupCaptureView() {
        roomCaptureView = RoomCaptureView(frame: view.bounds)
        roomCaptureView.delegate = self
        roomCaptureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(roomCaptureView)
    }

    private func setupButtons() {
        doneButton.setTitle("完成 Done", for: .normal)
        doneButton.titleLabel?.font = .boldSystemFont(ofSize: 18)
        doneButton.backgroundColor = .systemBlue
        doneButton.setTitleColor(.white, for: .normal)
        doneButton.layer.cornerRadius = 12
        doneButton.translatesAutoresizingMaskIntoConstraints = false
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        view.addSubview(doneButton)

        closeButton.setTitle("✕", for: .normal)
        closeButton.titleLabel?.font = .boldSystemFont(ofSize: 22)
        closeButton.setTitleColor(.white, for: .normal)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        view.addSubview(closeButton)

        NSLayoutConstraint.activate([
            doneButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            doneButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            doneButton.widthAnchor.constraint(equalToConstant: 180),
            doneButton.heightAnchor.constraint(equalToConstant: 52),
            closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            closeButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
        ])
    }

    @objc private func doneTapped() {
        roomCaptureView?.captureSession.stop()
        doneButton.isEnabled = false
        doneButton.setTitle("處理中 Processing…", for: .normal)
    }

    @objc private func closeTapped() {
        roomCaptureView?.captureSession.stop()
        dismiss(animated: true) { [weak self] in self?.onCancel?() }
    }

    // MARK: - RoomCaptureViewDelegate

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        if let error = error { print("RoomPlan processing error: \(error)") }
        let json: String
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(processedResult)
            json = String(data: data, encoding: .utf8) ?? ""
        } catch {
            print("JSON export failed: \(error)")
            json = ""
        }
        let payload = json
        dismiss(animated: true) { [weak self] in
            if payload.isEmpty { self?.onCancel?() } else { self?.onFinish?(payload) }
        }
    }
}
