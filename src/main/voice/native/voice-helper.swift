// Koda voice-input helper — on-device macOS Speech dictation (push-to-talk).
//
// LONG-LIVED streaming process (unlike the spawn-per-call assist helper): Koda spawns one per active
// dictation, reads stdout line-by-line, and stops it by writing a newline to / closing stdin (or
// SIGTERM). It captures the mic and emits transcript lines until told to stop.
//
// On-device ONLY (requiresOnDeviceRecognition = true): Koda is local-first / no-server, so if this
// machine can't transcribe on-device we emit an error and exit rather than fall back to Apple's cloud.
//
// Contract (so the Node side can treat each line as a typed event):
//   stdout: one JSON object per line (\n-terminated, flushed immediately)
//     {"type":"ready"}                       capture is live
//     {"type":"partial","text":"…"}          interim hypothesis (running text; may be revised)
//     {"type":"final","text":"…"}            a finalized segment
//     {"type":"error","reason":"permission|unsupported|engine|<detail>"}  any failure
//   exit 0 always (errors travel in JSON, not the exit code) — same shape discipline as assist-helper.swift.
//
// Build: swiftc -O voice-helper.swift -o voice-helper -framework Speech -framework AVFoundation
import Foundation
import Speech
import AVFoundation

// One write per line (JSON + '\n' in a single buffer) under a lock — recognition callbacks land on a
// background queue, so interleaved partial writes from another thread would corrupt a line otherwise.
let emitLock = NSLock()
func emit(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    data.append(0x0a)
    emitLock.lock()
    FileHandle.standardOutput.write(data)
    emitLock.unlock()
}

final class Dictation {
    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer() // current locale; nil if the locale is unsupported
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var stopped = false

    /// Walk the two permission prompts (speech, then mic), then start capturing. Any deny → error+exit.
    func start() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else { self.fail("permission"); return }
                self.requestMic()
            }
        }
    }

    private func requestMic() {
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async {
                granted ? self.beginCapture() : self.fail("permission")
            }
        }
    }

    private func beginCapture() {
        // On-device is a hard requirement — no cloud fallback (local-first). Bail if unsupported.
        guard let recognizer = recognizer, recognizer.supportsOnDeviceRecognition else {
            fail("unsupported"); return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            fail("engine"); return
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                if result.isFinal {
                    emit(["type": "final", "text": text])
                } else if !self.stopped {
                    emit(["type": "partial", "text": text])
                }
            }
            // An error BEFORE stop is a real mid-capture failure; an error after endAudio is the normal
            // wind-down (ignored). A final result — however it arrives — ends the process.
            if error != nil && !self.stopped {
                self.fail("engine"); return
            }
            if result?.isFinal == true { self.exitClean() }
        }

        emit(["type": "ready"])
    }

    /// Stop on a newline/EOF on stdin or SIGTERM: end the audio so the recognizer flushes a final, then
    /// exit regardless after a short grace (a wedged recognizer must never keep the process alive).
    func stop() {
        guard !stopped else { return }
        stopped = true
        teardownAudio()
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { self.exitClean() }
    }

    private func fail(_ reason: String) {
        emit(["type": "error", "reason": reason])
        exitClean()
    }

    private func teardownAudio() {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
    }

    private func exitClean() {
        teardownAudio()
        exit(0) // exit() never returns, so a second call (timer vs. final-result race) is harmless
    }
}

let dictation = Dictation()
dictation.start()

// Stop on a newline command OR stdin EOF (Koda writes "\n", then SIGTERMs as a backstop).
let stdin = FileHandle.standardInput
stdin.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty { stdin.readabilityHandler = nil } // EOF — stop firing
    DispatchQueue.main.async { dictation.stop() }
}

// SIGTERM → graceful stop. Ignore the default disposition first so it can't kill us mid-write.
signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { dictation.stop() }
sigterm.resume()

RunLoop.main.run()
