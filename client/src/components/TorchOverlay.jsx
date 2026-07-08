/**
 * Full-screen "LIGHTS ON" flash. This IS the torch mechanic on iOS (no web
 * torch API exists there) — the screen itself becomes the lamp. Android
 * additionally gets the real camera torch via enableTorch() in App.jsx.
 */
export default function TorchOverlay() {
  return (
    <div className="torch-flash">
      <div className="text-7xl">🔦</div>
      <div className="mt-4 text-4xl font-black tracking-wide">LIGHTS ON!</div>
      <div className="mt-2 max-w-xs px-6 text-lg font-medium text-neutral-700">
        Hold your phone screen up — everyone must be lit until the flash ends
      </div>
    </div>
  );
}
