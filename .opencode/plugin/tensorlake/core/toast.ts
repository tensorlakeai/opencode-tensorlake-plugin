type ToastVariant = 'success' | 'error' | 'warning' | 'info'

type ToastMessage = {
  title: string
  message: string
  variant: ToastVariant
}

class ToastManager {
  private tuiClient: any = null
  private queue: ToastMessage[] = []
  private processing = false

  initialize(tui: any): void {
    this.tuiClient = tui
  }

  show(msg: ToastMessage): void {
    if (!this.tuiClient) return
    this.queue.push(msg)
    if (!this.processing) this.processQueue()
  }

  private async processQueue(): Promise<void> {
    this.processing = true
    while (this.queue.length > 0) {
      const msg = this.queue.shift()!
      try {
        await this.tuiClient.toast({ title: msg.title, description: msg.message, variant: msg.variant })
      } catch {}
      await new Promise((r) => setTimeout(r, 2500))
    }
    this.processing = false
  }
}

export const toast = new ToastManager()
