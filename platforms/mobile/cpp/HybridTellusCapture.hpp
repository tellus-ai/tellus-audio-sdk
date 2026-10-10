#pragma once

#include "CaptureSession.hpp"
#include "HybridTellusCaptureSpec.hpp"

namespace margelo::nitro::tellus {

// Nitro는 encoded 청크만 JS에 전달한다. 모델·승인·처리 상태는 capture 인스턴스에 묶인다.
class HybridTellusCapture final : public HybridTellusCaptureSpec {
public:
  HybridTellusCapture();
  std::shared_ptr<Promise<void>> configure(const std::string& json, double processingRate) override;
  std::shared_ptr<Promise<std::string>> createAuthorizationRequest(const std::string& conversationId) override;
  std::shared_ptr<Promise<std::string>> applyAuthorization(const std::string& token) override;
  std::shared_ptr<Promise<std::string>> getAuthorizationStatus() override;
  void invalidateAuthorization() override;
  std::shared_ptr<Promise<std::string>> createModelKeyRequest() override;
  std::shared_ptr<Promise<std::string>> inspectModelFile(const std::string& path) override;
  std::shared_ptr<Promise<void>> applyModelKey(const std::string& modelId, const std::string& keyId,
                                             const std::shared_ptr<ArrayBuffer>& wrappedKey) override;
  std::shared_ptr<Promise<void>> loadModelFile(const std::string& path) override;
  std::shared_ptr<Promise<void>> start(
      const std::function<void(const std::shared_ptr<ArrayBuffer>&, const std::string&, uint64_t, uint64_t)>& onChunk,
      const std::function<void(const std::string&)>& onError) override;
  std::shared_ptr<Promise<void>> pause() override;
  std::shared_ptr<Promise<void>> resume() override;
  std::shared_ptr<Promise<void>> stop() override;
  std::shared_ptr<Promise<void>> close() override;
  std::shared_ptr<Promise<void>> reset() override;
  std::shared_ptr<Promise<std::string>> getStatus() override;
  std::shared_ptr<Promise<void>> setDenoiseEnabled(bool enabled) override;
  std::shared_ptr<Promise<void>> setRecordingNotification(const std::string& title, const std::string& contentText,
    bool pauseAction, bool resumeAction, const std::function<void(const std::string&)>& onAction) override;
  std::shared_ptr<Promise<void>> playback(const std::shared_ptr<ArrayBuffer>& samples, double rate) override;
  std::shared_ptr<Promise<void>> playbackEncoded(const std::shared_ptr<ArrayBuffer>& encoded) override;
  std::shared_ptr<Promise<void>> cancelPlayback() override;
  bool canDeliver(uint64_t epoch, uint64_t generation) override;
  void acknowledgeChunk() override;
  void dispose() override;

private:
  std::shared_ptr<CaptureSession> acquire();
  std::mutex _mutex;
  std::shared_ptr<CaptureSession> _session;
};

} // namespace margelo::nitro::tellus
