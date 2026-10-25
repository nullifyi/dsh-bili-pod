/** Replace the current companion identity while its system prompt is assembled. */
export function createCompanionIdentityHook({ isCompanion, readDocument, onApplied = () => {} }) {
  return async (_assembly, context, next) => {
    const assembled = await next()
    if (!isCompanion(context.agent)) return assembled
    const document = readDocument()
    if (!document.exists || !document.text.trim()) return assembled
    const persona = { name: 'deployment:persona-prefix', text: document.text.trim(), interpolate: false }
    const baseSections = assembled.sections.filter(section => section.name !== 'dsh-bili-pod:dialogue-cue')
    const hasPersona = baseSections.some(section => section.name === persona.name)
    const sections = hasPersona
      ? baseSections.map(section => section.name === persona.name ? persona : section)
      : [persona, ...baseSections]
    const cue = /(?:^|\r?\n)## 开口时[ \t]*\r?\n([\s\S]*?)(?=\r?\n## |$)/.exec(document.text)?.[1]?.trim()
    if (cue) sections.push({ name: 'dsh-bili-pod:dialogue-cue', text: cue, interpolate: false })
    onApplied(document)
    return { ...assembled, sections }
  }
}
