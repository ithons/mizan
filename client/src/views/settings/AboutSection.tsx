export function AboutSection() {
  return (
    <div className="space-y-3 max-w-md">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted mb-0.5">Version</p>
          <p className="text-text font-mono">0.1.0</p>
        </div>
        <div>
          <p className="text-xs text-muted mb-0.5">License</p>
          <p className="text-text">MIT</p>
        </div>
      </div>
      <p className="text-xs text-muted pt-2">
        Mizān is a self-hosted personal finance app. Your data never leaves your machine.
      </p>
    </div>
  );
}
