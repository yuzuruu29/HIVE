import { Dialog } from "../Dialog";

export interface ShortcutHelpProps {
  onClose: () => void;
}

export function ShortcutHelp({ onClose }: ShortcutHelpProps) {
  const shortcuts = [
    { key: "Ctrl + K", desc: "Open command palette" },
    { key: "Ctrl + Enter", desc: "Submit composer message" },
    { key: "Ctrl + 1", desc: "Switch to Conversation tab" },
    { key: "Ctrl + 2", desc: "Switch to Changes tab" },
    { key: "Ctrl + 3", desc: "Switch to Report tab" },
    { key: "? (Shift + /)", desc: "Show keyboard shortcuts" },
    { key: "Escape", desc: "Close dialog or command palette" },
  ];

  return (
    <Dialog title="Keyboard Shortcuts" onClose={onClose}>
      <table className="shortcut-table">
        <tbody>
          {shortcuts.map(({ key, desc }) => (
            <tr key={key}>
              <td>
                <kbd>{key}</kbd>
              </td>
              <td>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dialog-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}
