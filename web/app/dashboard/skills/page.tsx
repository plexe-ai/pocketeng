'use client'

import { useState, useEffect } from 'react'
import {
  BUILT_IN_HARNESS_SKILL_CONTENT,
  BUILT_IN_HARNESS_SKILLS,
  HARNESS_CATEGORY_SECTION_LABELS,
  type HarnessCustomSkill,
  type HarnessSkillDef,
} from '@/lib/harnessSkills'
import { getRestoredSession, supabase } from '@/lib/supabase'

export default function SkillsPage() {
  const [customSkills, setCustomSkills] = useState<HarnessCustomSkill[]>([])
  // Overrides for built-in skills: { skillId: customContent }
  const [builtinOverrides, setBuiltinOverrides] = useState<Record<string, string>>({})
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingBuiltin, setEditingBuiltin] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formContent, setFormContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // getRestoredSession() so a flaky mobile-resume network call
        // doesn't show an empty skills list when the user actually has
        // skills configured. See learnings/2026-04-mobile-route-guards-must-not-use-getuser.md.
        const session = await getRestoredSession()
        if (cancelled) return
        const meta = session?.user.user_metadata ?? {}
        if (meta.customSkills?.length) {
          setCustomSkills(meta.customSkills.map((skill: any) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description || 'Custom skill',
            content: skill.content,
          })))
        }
        if (meta.skillOverrides) setBuiltinOverrides(meta.skillOverrides)
      } catch (e) {
        console.error('Failed to load skills:', e)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function persist(skills: HarnessCustomSkill[], overrides: Record<string, string>) {
    setSaving(true)
    try {
      await supabase.auth.updateUser({ data: { customSkills: skills, skillOverrides: overrides } })
    } catch (e) {
      console.error('Failed to save skills:', e)
    } finally {
      setSaving(false)
    }
  }

  function openCreate() {
    setEditingId(null)
    setEditingBuiltin(false)
    setFormName('')
    setFormDesc('')
    setFormContent('')
    setShowForm(true)
  }

  function openEditCustom(skill: HarnessCustomSkill) {
    setEditingId(skill.id)
    setEditingBuiltin(false)
    setFormName(skill.name)
    setFormDesc(skill.description)
    setFormContent(skill.content)
    setShowForm(true)
  }

  function openEditBuiltin(skill: HarnessSkillDef) {
    setEditingId(skill.id)
    setEditingBuiltin(true)
    setFormName(skill.name)
    setFormDesc(skill.description)
    setFormContent(builtinOverrides[skill.id] ?? BUILT_IN_HARNESS_SKILL_CONTENT[skill.id] ?? '')
    setShowForm(true)
  }

  function closeForm() {
    setShowForm(false)
    setEditingId(null)
    setEditingBuiltin(false)
  }

  async function handleSave() {
    if (editingBuiltin && editingId) {
      // Save override for built-in skill
      const newOverrides = { ...builtinOverrides, [editingId]: formContent }
      // If content matches default, remove the override
      if (formContent.trim() === (BUILT_IN_HARNESS_SKILL_CONTENT[editingId] ?? '').trim()) {
        delete newOverrides[editingId]
      }
      setBuiltinOverrides(newOverrides)
      await persist(customSkills, newOverrides)
      closeForm()
      return
    }

    if (!formName.trim()) return

    let updated: HarnessCustomSkill[]
    if (editingId) {
      updated = customSkills.map(s =>
        s.id === editingId
          ? { ...s, name: formName.trim(), description: formDesc.trim() || 'Custom skill', content: formContent }
          : s
      )
    } else {
      const id = 'custom-' + formName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      updated = [...customSkills, {
        id,
        name: formName.trim(),
        description: formDesc.trim() || 'Custom skill',
        content: formContent,
      }]
    }
    setCustomSkills(updated)
    await persist(updated, builtinOverrides)
    closeForm()
  }

  async function handleDelete(id: string) {
    const updated = customSkills.filter(s => s.id !== id)
    setCustomSkills(updated)
    await persist(updated, builtinOverrides)
  }

  async function handleResetBuiltin(id: string) {
    const newOverrides = { ...builtinOverrides }
    delete newOverrides[id]
    setBuiltinOverrides(newOverrides)
    await persist(customSkills, newOverrides)
  }

  // Combine for display
  const allSkills: (HarnessSkillDef & { hasOverride?: boolean })[] = [
    ...BUILT_IN_HARNESS_SKILLS.map(s => ({
      ...s,
      hasOverride: Object.prototype.hasOwnProperty.call(builtinOverrides, s.id),
    })),
    ...customSkills.map(s => ({
      id: s.id, name: s.name, description: s.description,
      category: 'custom' as const, builtin: false,
    })),
  ]

  const grouped = allSkills.reduce<Record<string, typeof allSkills>>((acc, s) => {
    acc[s.category] = acc[s.category] || []
    acc[s.category].push(s)
    return acc
  }, {})

  return (
    <div className="px-5 py-4 md:px-8 md:py-8 max-w-xl animate-fade-in">
      <div className="flex items-center justify-between mb-6 md:mb-8">
        <div>
          <h1 className="hidden md:block text-[16px] font-semibold text-bright tracking-tight">Harness</h1>
          <p className="text-[12px] text-tertiary md:mt-1">
            Knowledge and conventions your coding agents follow.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saving && (
            <span className="flex items-center gap-1.5 text-[11px] text-tertiary">
              <span className="w-2.5 h-2.5 border-[1.5px] border-accent/20 border-t-accent rounded-full animate-spin" />
              Saving
            </span>
          )}
          <button onClick={openCreate}
            className="text-[12px] text-accent hover:text-accent/80 transition-colors cursor-pointer font-medium">
            + New skill
          </button>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-xl bg-l1 border border-line p-5 mb-6 animate-fade-in">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[13px] font-medium text-bright">
              {editingBuiltin ? `Edit ${formName}` : editingId ? 'Edit skill' : 'New skill'}
            </p>
            <button onClick={closeForm}
              className="text-tertiary hover:text-secondary transition-colors cursor-pointer">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex flex-col gap-3">
            {!editingBuiltin && (
              <>
                <div>
                  <label className="text-[11px] text-tertiary mb-1 block">Name</label>
                  <input type="text" value={formName} onChange={e => setFormName(e.target.value)}
                    placeholder="e.g. React Native"
                    className="w-full bg-transparent text-[13px] text-bright placeholder:text-tertiary outline-none border-b border-line pb-2 focus:border-accent/30 transition-colors" />
                </div>
                <div>
                  <label className="text-[11px] text-tertiary mb-1 block">Description</label>
                  <input type="text" value={formDesc} onChange={e => setFormDesc(e.target.value)}
                    placeholder="What this skill teaches the agent"
                    className="w-full bg-transparent text-[13px] text-bright placeholder:text-tertiary outline-none border-b border-line pb-2 focus:border-accent/30 transition-colors" />
                </div>
              </>
            )}
            <div>
              <label className="text-[11px] text-tertiary mb-1 block">Instructions (markdown)</label>
              <textarea value={formContent} onChange={e => setFormContent(e.target.value)}
                placeholder={"# My Skill\n\nConventions, patterns, and rules for the agent to follow..."}
                className="w-full bg-transparent text-[12px] text-bright font-mono placeholder:text-tertiary outline-none border border-line rounded-lg p-3 focus:border-accent/30 transition-colors resize-y min-h-[200px] h-[300px]" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={closeForm} className="btn btn-ghost cursor-pointer text-[12px]">Cancel</button>
              <button onClick={handleSave} disabled={(!editingBuiltin && !formName.trim()) || saving}
                className="btn btn-primary cursor-pointer">
                {editingId ? 'Save changes' : 'Create skill'}
              </button>
            </div>
          </div>
        </div>
      )}

      {!loaded && (
        <div className="flex items-center gap-2 py-8 justify-center">
          <span className="w-3 h-3 border-[1.5px] border-accent/20 border-t-accent rounded-full animate-spin" />
          <span className="text-[12px] text-tertiary">Loading skills...</span>
        </div>
      )}

      {loaded && (['framework', 'workflow', 'tool', 'custom'] as const).map(cat => {
        const items = grouped[cat]
        if (!items?.length) return null
        return (
          <div key={cat} className="mb-6">
            <p className="text-[11px] text-tertiary uppercase tracking-widest mb-3">
              {HARNESS_CATEGORY_SECTION_LABELS[cat]}
            </p>
            <div className="flex flex-col gap-2">
              {items.map(skill => (
                <div key={skill.id}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl bg-l1 border border-line hover-lift">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-l1 flex-shrink-0">
                    <svg className="w-4 h-4 text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-medium text-bright">{skill.name}</p>
                      {'hasOverride' in skill && skill.hasOverride && (
                        <span className="text-[9px] text-accent bg-accent/10 px-1.5 py-0.5 rounded-full">customized</span>
                      )}
                    </div>
                    <p className="text-[11px] text-tertiary truncate">{skill.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {skill.builtin ? (
                      <>
                        {'hasOverride' in skill && skill.hasOverride && (
                          <button onClick={() => handleResetBuiltin(skill.id)}
                            className="text-[11px] text-tertiary hover:text-secondary transition-colors cursor-pointer">
                            Reset
                          </button>
                        )}
                        <button onClick={() => openEditBuiltin(skill as HarnessSkillDef)}
                          className="text-[11px] text-accent hover:text-accent/80 transition-colors cursor-pointer">
                          Edit
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => openEditCustom(customSkills.find(s => s.id === skill.id)!)}
                          className="text-[11px] text-accent hover:text-accent/80 transition-colors cursor-pointer">
                          Edit
                        </button>
                        <button onClick={() => handleDelete(skill.id)}
                          className="text-[11px] text-tertiary hover:text-danger transition-colors cursor-pointer">
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
