import { Dialog } from "../Dialog";
import { usePrefs } from "../prefs";

export interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const { prefs, updatePrefs } = usePrefs();

  const density = prefs.density ?? "comfortable";
  const accent = prefs.accent ?? "vivid";
  const notifications = prefs.notifications ?? true;

  return (
    <Dialog title="Preferences & Accessibility" onClose={onClose}>
      <div className="settings-group">
        <fieldset>
          <legend>Layout Density</legend>
          <div className="settings-options">
            <label className="settings-label">
              <input
                type="radio"
                name="density"
                value="comfortable"
                checked={density === "comfortable"}
                onChange={() => updatePrefs({ density: "comfortable" })}
              />
              <span>Comfortable (default)</span>
            </label>
            <label className="settings-label">
              <input
                type="radio"
                name="density"
                value="compact"
                checked={density === "compact"}
                onChange={() => updatePrefs({ density: "compact" })}
              />
              <span>Compact</span>
            </label>
          </div>
        </fieldset>
      </div>

      <div className="settings-group">
        <fieldset>
          <legend>Color Accent</legend>
          <div className="settings-options">
            <label className="settings-label">
              <input
                type="radio"
                name="accent"
                value="vivid"
                checked={accent === "vivid"}
                onChange={() => updatePrefs({ accent: "vivid" })}
              />
              <span>Vivid Violet</span>
            </label>
            <label className="settings-label">
              <input
                type="radio"
                name="accent"
                value="contrast"
                checked={accent === "contrast"}
                onChange={() => updatePrefs({ accent: "contrast" })}
              />
              <span>High Contrast</span>
            </label>
          </div>
        </fieldset>
      </div>

      <div className="settings-group">
        <label className="settings-label">
          <input
            type="checkbox"
            checked={notifications}
            onChange={(e) => updatePrefs({ notifications: e.target.checked })}
          />
          <span>Background Notifications (when window is inactive)</span>
        </label>
      </div>

      <p className="technical-note">
        Motion follows your OS reduced-motion setting.
      </p>

      <div className="dialog-actions">
        <button onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
