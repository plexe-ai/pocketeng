'use client'

import { useState } from 'react'
import { connectServer, installAgent } from '@/lib/api'

interface Props {
  onConnected: () => void
  onCancel: () => void
}

export default function ConnectForm({ onConnected, onCancel }: Props) {
  const [host, setHost]     = useState('')
  const [user, setUser]     = useState('ec2-user')
  const [key, setKey]       = useState('')
  const [label, setLabel]   = useState('')
  const [busy, setBusy]     = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [agents, setAgents]       = useState<string[] | null>(null)
  const [connected, setConnected] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled]   = useState(false)
  const [serverId, setServerId]     = useState<string | null>(null)

  async function handleConnect() {
    if (!host.trim() || !key.trim()) return
    setBusy(true)
    setError(null)
    setWarning(null)
    setAgents(null)
    try {
      const res = await connectServer({
        host: host.trim(),
        sshUser: user.trim() || 'ec2-user',
        sshPrivateKey: key.trim(),
        label: label.trim() || host.trim(),
      })
      setServerId(res.serverId)
      if (res.agents?.length) setAgents(res.agents)
      if (res.warning) setWarning(res.warning)
      setConnected(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[15px] font-semibold text-bright">Connect existing server</p>
          <p className="text-[12px] text-tertiary mt-0.5">Bring your own EC2, VPS, or Mac.</p>
        </div>
        <button onClick={onCancel} className="text-tertiary hover:text-secondary transition-colors cursor-pointer">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Host */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-bright">Host / IP</label>
        <input
          type="text"
          value={host}
          onChange={e => setHost(e.target.value)}
          placeholder="54.123.45.67"
          className="bg-transparent text-[13px] text-bright placeholder:text-tertiary outline-none border-b border-line pb-2 focus:border-accent/30 transition-colors font-mono"
        />
        <p className="text-[11px] text-tertiary">The public IP or hostname of your server.</p>
      </div>

      {/* Username + Label */}
      <div className="grid grid-cols-2 gap-5">
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] font-medium text-bright">SSH user</label>
          <input
            type="text"
            value={user}
            onChange={e => setUser(e.target.value)}
            placeholder="ec2-user"
            className="bg-transparent text-[13px] text-bright placeholder:text-tertiary outline-none border-b border-line pb-2 focus:border-accent/30 transition-colors font-mono"
          />
          <p className="text-[11px] text-tertiary">Usually ec2-user, ubuntu, or root.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] font-medium text-bright">Label <span className="text-tertiary font-normal">(optional)</span></label>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="My server"
            className="bg-transparent text-[13px] text-bright placeholder:text-tertiary outline-none border-b border-line pb-2 focus:border-accent/30 transition-colors"
          />
          <p className="text-[11px] text-tertiary">A friendly name for this server.</p>
        </div>
      </div>

      {/* SSH Key */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-bright">SSH private key</label>
        <textarea
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n..."}
          rows={4}
          className="bg-transparent text-[12px] text-bright placeholder:text-tertiary outline-none border border-line rounded-lg p-3 focus:border-accent/30 transition-colors font-mono resize-none"
        />
        <p className="text-[11px] text-tertiary">Paste your .pem or OpenSSH key. Stored encrypted with KMS.</p>
      </div>

      {error && <p className="text-[12px] text-danger animate-fade-in">{error}</p>}

      {connected ? (
        <div className="flex flex-col gap-3 animate-fade-in">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <p className="text-[13px] text-bright font-medium">Connected</p>
          </div>
          {agents && agents.length > 0 && (
            <p className="text-[12px] text-secondary">
              Agents installed: {agents.map(a => a === 'claude' ? 'Claude Code' : a === 'codex' ? 'Codex' : a === 'cursor' ? 'Cursor' : a === 'opencode' ? 'OpenCode' : a).join(', ')}
            </p>
          )}
          {warning && !installed && (
            <div className="flex flex-col gap-2">
              <p className="text-[12px] text-amber">{warning}</p>
              {serverId && (
                <button
                  onClick={async () => {
                    setInstalling(true)
                    try {
                      await installAgent(serverId, 'claude')
                      setInstalled(true)
                      setWarning(null)
                      setAgents(['claude'])
                    } catch (e) {
                      setWarning(`Install failed: ${(e as Error).message}`)
                    } finally {
                      setInstalling(false)
                    }
                  }}
                  disabled={installing}
                  className="btn btn-accent-outline btn-sm cursor-pointer self-start"
                >
                  {installing ? 'Installing Claude Code...' : 'Install Claude Code'}
                </button>
              )}
            </div>
          )}
          {installed && (
            <div className="flex items-center gap-2 animate-fade-in">
              <svg className="w-3 h-3 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              <p className="text-[12px] text-accent">Claude Code installed</p>
            </div>
          )}
          <div className="flex justify-end">
            <button onClick={onConnected} className="btn btn-primary cursor-pointer">Done</button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end pt-2">
          <button
            onClick={handleConnect}
            disabled={!host.trim() || !key.trim() || busy}
            className="btn btn-primary cursor-pointer"
          >
            {busy ? 'Verifying...' : 'Connect'}
          </button>
        </div>
      )}
    </div>
  )
}
