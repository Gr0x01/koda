// Koda voice-input helper — on-device macOS dictation (push-to-talk).
//
// LONG-LIVED streaming process (unlike the spawn-per-call assist helper): Koda spawns one per active
// dictation, reads stdout line-by-line, and stops it by writing a newline to / closing stdin (or
// SIGTERM). It captures the mic and emits transcript lines until told to stop.
//
// Two engines behind one contract, chosen at runtime by OS version:
//   • macOS 26+  → SpeechAnalyzer + SpeechTranscriber (the new on-device engine that powers system
//                  dictation; far better accuracy/punctuation than the old API, still 100% on-device).
//   • macOS <26  → SFSpeechRecognizer with requiresOnDeviceRecognition (the legacy fallback).
// Both are on-device ONLY — Koda is local-first / no-server, so a machine that can't transcribe
// on-device emits an error and exits rather than fall back to Apple's cloud.
//
// Contract (so the Node side can treat each line as a typed event):
//   stdout: one JSON object per line (\n-terminated, flushed immediately)
//     {"type":"ready"}                       capture is live
//     {"type":"partial","text":"…"}          the FULL running transcript so far (revised as you speak)
//     {"type":"final","text":"…"}            the complete transcript, emitted once at stop → ends dictation
//     {"type":"error","reason":"permission|unsupported|engine|<detail>"}  any failure
//   exit 0 always (errors travel in JSON, not the exit code) — same shape discipline as assist-helper.swift.
//
// The renderer REPLACES the draft with each event's `text` and treats `final` as the stop signal, so
// every engine emits the whole running transcript in `partial`s and exactly one `final` at the end.
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

func exitClean() -> Never {
    exit(0) // exit() never returns, so a second call (timer vs. final-result race) is harmless
}

// Any dictation backend: start capturing, and stop (flushing a single final) on command.
protocol DictationEngine: AnyObject {
    func begin()
    func stop()
}

// ── Modern engine: SpeechAnalyzer + SpeechTranscriber (macOS 26+) ─────────────────────────────────
//
// SpeechTranscriber streams volatile (interim) results plus finalized segments as you speak. We keep a
// running `finalized` string and emit the whole `finalized + volatile` transcript on every result as a
// `partial`; the single `final` event is flushed only at stop(), matching the one-utterance contract.

/// The mic's native tap format won't match the analyzer's required format, so each buffer is converted.
@available(macOS 26.0, *)
final class BufferConverter {
    private var converter: AVAudioConverter?

    func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let inputFormat = buffer.format
        if inputFormat == format { return buffer }

        if converter == nil || converter?.outputFormat != format {
            converter = AVAudioConverter(from: inputFormat, to: format)
            converter?.primeMethod = .none
        }
        guard let converter else { return nil }

        let ratio = converter.outputFormat.sampleRate / converter.inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else {
            return nil
        }

        var consumed = false
        var nsError: NSError?
        let status = converter.convert(to: output, error: &nsError) { _, statusPtr in
            statusPtr.pointee = consumed ? .noDataNow : .haveData
            defer { consumed = true }
            return consumed ? nil : buffer
        }
        return status == .error ? nil : output
    }
}

@available(macOS 26.0, *)
final class ModernDictation: DictationEngine {
    private let audioEngine = AVAudioEngine()
    private let converter = BufferConverter()
    private var transcriber: SpeechTranscriber?
    private var analyzer: SpeechAnalyzer?
    private var inputCont: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzerFormat: AVAudioFormat?
    private var resultsTask: Task<Void, Never>?
    private var finalized = ""
    private var stopped = false

    func begin() {
        Task { await self.setup() }
    }

    private func setup() async {
        let locale = Locale.current
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )
        self.transcriber = transcriber
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer

        // Ensure the on-device model for this locale is installed (a first-run download that delays
        // `ready`); a locale we can't transcribe at all is `unsupported`, everything else is `engine`.
        do {
            let installed = await SpeechTranscriber.installedLocales
            let have = Set(installed.map { $0.identifier(.bcp47) })
            if !have.contains(locale.identifier(.bcp47)) {
                guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
                    fail("unsupported"); return
                }
                try await request.downloadAndInstall()
            }
        } catch {
            fail("engine"); return
        }

        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            fail("unsupported"); return
        }
        analyzerFormat = format

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        inputCont = continuation
        resultsTask = Task { [weak self] in await self?.consume(transcriber) }

        do {
            try await analyzer.start(inputSequence: stream)
            try startMic()
        } catch {
            fail("engine"); return
        }
        emit(["type": "ready"])
    }

    private func consume(_ transcriber: SpeechTranscriber) async {
        do {
            for try await result in transcriber.results {
                if stopped { continue }
                let text = String(result.text.characters)
                if result.isFinal { finalized += text }
                emit(["type": "partial", "text": result.isFinal ? finalized : finalized + text])
            }
        } catch {
            if !stopped { fail("engine") }
        }
    }

    private func startMic() throws {
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self, let analyzerFormat = self.analyzerFormat, let cont = self.inputCont else { return }
            if let converted = self.converter.convert(buffer, to: analyzerFormat) {
                cont.yield(AnalyzerInput(buffer: converted))
            }
        }
        audioEngine.prepare()
        try audioEngine.start()
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        teardownAudio()
        Task {
            inputCont?.finish()
            try? await analyzer?.finalizeAndFinishThroughEndOfInput()
            await resultsTask?.value // drain any finals flushed by finalize before reading `finalized`
            emit(["type": "final", "text": finalized.trimmingCharacters(in: .whitespacesAndNewlines)])
            exitClean()
        }
        // Backstop: never let a wedged analyzer keep the process alive past a short grace.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { exitClean() }
    }

    private func teardownAudio() {
        if audioEngine.isRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }
    }

    private func fail(_ reason: String) {
        emit(["type": "error", "reason": reason])
        exitClean()
    }
}

// ── Legacy engine: SFSpeechRecognizer on-device (macOS <26) ────────────────────────────────────────

final class LegacyDictation: DictationEngine {
    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer() // current locale; nil if the locale is unsupported
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var stopped = false

    func begin() {
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
            if result?.isFinal == true { exitClean() }
        }

        emit(["type": "ready"])
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        teardownAudio()
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { exitClean() }
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
}

// ── Permission walk + engine selection ─────────────────────────────────────────────────────────────

// The active engine's stop(), so stdin/SIGTERM can wind it down. Set on .main once permissions clear.
var stopHandler: (() -> Void)?

/// Walk the two permission prompts (speech, then mic); any deny → error+exit. SpeechTranscriber still
/// requires speech-recognition authorization even though it's on-device, so both engines gate the same.
func requestPermissions(_ done: @escaping (Bool) -> Void) {
    SFSpeechRecognizer.requestAuthorization { status in
        DispatchQueue.main.async {
            guard status == .authorized else { done(false); return }
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async { done(granted) }
            }
        }
    }
}

requestPermissions { granted in
    guard granted else {
        emit(["type": "error", "reason": "permission"])
        exitClean()
    }
    let engine: DictationEngine
    if #available(macOS 26.0, *) {
        engine = ModernDictation()
    } else {
        engine = LegacyDictation()
    }
    stopHandler = { engine.stop() }
    engine.begin()
}

// Stop on a newline command OR stdin EOF (Koda writes "\n", then SIGTERMs as a backstop).
let stdin = FileHandle.standardInput
stdin.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty { stdin.readabilityHandler = nil } // EOF — stop firing
    DispatchQueue.main.async { stopHandler?() }
}

// SIGTERM → graceful stop. Ignore the default disposition first so it can't kill us mid-write.
signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { stopHandler?() }
sigterm.resume()

RunLoop.main.run()
