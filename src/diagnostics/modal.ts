import { App, Modal, Notice, Setting } from "obsidian";

export class DiagnosticReportModal extends Modal {
  constructor(app: App, private readonly report: string) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Диагностика Ajimo Sync");
    this.contentEl.createEl("p", {
      text: "Отчёт содержит версию, параметры автосинхронизации и счётчики последнего запуска. URL сервера, токен, ключ, имена файлов и текст ошибок исключены. Отчёт никуда не отправляется."
    });
    const textarea = this.contentEl.createEl("textarea", { cls: "private-sync-diagnostics" });
    textarea.value = this.report;
    textarea.readOnly = true;
    textarea.spellcheck = false;
    textarea.rows = 18;
    textarea.setAttribute("aria-label", "Диагностический отчёт");
    new Setting(this.contentEl).addButton(button => button
      .setButtonText("Копировать отчёт")
      .setCta()
      .onClick(async () => {
        button.setDisabled(true);
        try {
          const clipboard = textarea.ownerDocument.defaultView?.navigator.clipboard;
          if (!clipboard) throw new Error("Clipboard unavailable");
          await clipboard.writeText(this.report);
          new Notice("Диагностический отчёт скопирован.");
        } catch {
          textarea.focus();
          textarea.select();
          new Notice("Скопируйте выделенный отчёт вручную: буфер обмена недоступен.");
        } finally {
          button.setDisabled(false);
        }
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
