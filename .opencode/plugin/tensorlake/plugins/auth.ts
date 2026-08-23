import type { AuthHook } from '@opencode-ai/plugin'
import { PROVIDER_ID } from '../core/credentials.js'

/**
 * Registers Tensorlake as a provider in `opencode auth login`. OpenCode shows
 * its own masked "Enter your API key" prompt for `api` methods and stores the
 * key in its credential store (auth.json). The method must not define a text
 * prompt or `authorize`: OpenCode renders text prompts unmasked (echoing the
 * key on screen) and never passes the masked key to `authorize`, so a text
 * prompt forces the user to enter the key twice. The key is checked lazily on
 * first use instead (see session-manager.ts).
 *
 * The single-option select below is the only way to show where to get the key:
 * OpenCode's key prompt message is hardcoded and `api` methods have no
 * instructions field. Pasting a key into the select is inert, so it cannot
 * leak the key. Its value lands in auth.json metadata, which nothing reads.
 */
export const authHook: AuthHook = {
  provider: PROVIDER_ID,
  methods: [
    {
      type: 'api',
      label: 'Project API key',
      prompts: [
        {
          type: 'select',
          key: 'hint',
          message: 'Get your API key from https://cloud.tensorlake.ai (open your project → API Keys)',
          options: [{ label: 'I have my key — continue', value: 'ok' }],
        },
      ],
    },
  ],
}
