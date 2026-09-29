import { CaptureSession } from "./capture-session";

export default function ScanPage() {
  return (
    <CaptureSession
      candidateCaptureEnabled={
        process.env.CAPTURE_CANDIDATE_MODE_ENABLED === "true"
      }
    />
  );
}
