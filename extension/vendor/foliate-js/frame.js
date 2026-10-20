// Tabgent patch: bounded, cancellable frame loading shared by both renderers.
export const cancelled = () => new DOMException('Chapter navigation superseded', 'AbortError')

export const loadFrame = (iframe, source, signal) => new Promise((resolve, reject) => {
    const cleanup = () => {
        clearTimeout(timer)
        iframe.removeEventListener('load', loaded)
        iframe.removeEventListener('error', failed)
        signal?.removeEventListener('abort', aborted)
    }
    const fail = error => {
        cleanup()
        reject(error)
    }
    const aborted = () => fail(cancelled())
    const loaded = () => {
        try {
            if (!iframe.isConnected || signal?.aborted) return aborted()
            const doc = iframe.contentDocument
            // Appending a frame can queue an initial load before its chapter.
            if (doc?.URL === 'about:blank') return
            if (!doc?.body) throw new Error('The chapter document is not accessible')
            cleanup()
            resolve(doc)
        } catch (error) { fail(error) }
    }
    const failed = () => fail(new Error('The chapter could not be loaded'))
    const timer = setTimeout(() => {
        if (!iframe.isConnected || signal?.aborted) aborted()
        else fail(new Error('The chapter took too long to load'))
    }, 15000)
    iframe.addEventListener('load', loaded)
    iframe.addEventListener('error', failed)
    signal?.addEventListener('abort', aborted, { once: true })
    try {
        if (signal?.aborted) return aborted()
        if (typeof source === 'string') iframe.src = source
        else if (typeof source?.srcdoc === 'string') iframe.srcdoc = source.srcdoc
        else fail(new Error('The chapter has no readable content'))
    } catch (error) { fail(error) }
})
