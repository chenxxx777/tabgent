// Tabgent patch: share bounded frame loading between the reflowable and fixed renderers.
// Exceptions in a DOM load listener otherwise leave the renderer's promise pending forever.
export const loadFrame = (iframe, source) => new Promise((resolve, reject) => {
    const cleanup = () => {
        clearTimeout(timer)
        iframe.removeEventListener('load', loaded)
        iframe.removeEventListener('error', failed)
    }
    const fail = error => {
        cleanup()
        reject(error)
    }
    const loaded = () => {
        try {
            const doc = iframe.contentDocument
            // Appending an iframe can queue an initial about:blank load before the chapter.
            if (doc?.URL === 'about:blank') return
            if (!doc?.body) throw new Error('The chapter document is not accessible')
            cleanup()
            resolve(doc)
        } catch (error) { fail(error) }
    }
    const failed = () => fail(new Error('The chapter could not be loaded'))
    const timer = setTimeout(() => fail(new Error('The chapter took too long to load')), 15000)
    iframe.addEventListener('load', loaded)
    iframe.addEventListener('error', failed)
    try {
        if (typeof source === 'string') iframe.src = source
        else if (typeof source?.srcdoc === 'string') iframe.srcdoc = source.srcdoc
        else fail(new Error('The chapter has no readable content'))
    } catch (error) { fail(error) }
})
