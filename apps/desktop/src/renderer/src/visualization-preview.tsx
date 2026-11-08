/** Development-only gallery: runs the real reply renderer without Electron IPC. */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { themeList, type ThemeId } from '@ari/ui/themes'
import { visualizationExamples } from '../../../../../packages/ui/src/visualization/examples'
import '@ari/ui/fonts'
import { MarkdownBlock } from './features/transcript/MarkdownBlock'
import './styles/index.css'
import './features/transcript/transcript.css'
import '@ari/ui/visualization.css'
import './visualization-preview.css'

function Gallery() {
  const [theme, setTheme] = useState<ThemeId>('obsidian')
  const [category, setCategory] = useState('All')
  useEffect(() => {
    document.documentElement.dataset['ariTheme'] = theme
  }, [theme])
  const examples = visualizationExamples.filter(
    (example) => category === 'All' || example.category === category,
  )
  useEffect(() => {
    const host = window as Window & { __ari?: { state: () => unknown } }
    host.__ari = {
      state: () => ({
        theme: document.documentElement.dataset['ariTheme'],
        visuals: document.querySelectorAll('.ari-viz').length,
        types: Array.from(document.querySelectorAll('.ari-viz')).map((el) =>
          el.getAttribute('data-type'),
        ),
        background: getComputedStyle(document.querySelector('.ari-viz') ?? document.body)
          .backgroundColor,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--ari-accent').trim(),
        consoleReady: true,
      }),
    }
    return () => {
      delete host.__ari
    }
  }, [])
  return (
    <main className="viz-gallery">
      <header>
        <a href="/visualizations.html" className="viz-gallery-wordmark">
          ari<span>/</span>visualizations
        </a>
        <label>
          Theme
          <select
            aria-label="Theme"
            value={theme}
            onChange={(event) => setTheme(event.target.value as ThemeId)}
          >
            {themeList.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      <section className="viz-gallery-intro">
        <span className="viz-gallery-eyebrow">Made for the conversation</span>
        <h1>
          Some things are
          <br />
          clearer when you see them.
        </h1>
        <p>
          Charts, diagrams, and structured briefs, shaped by Ari.
          <br />
          Explore 15 ways to turn an explanation into something you can inspect.
        </p>
        <nav aria-label="Visualization categories">
          {['All', 'Charts', 'Diagrams', 'Briefs'].map((label) => (
            <button
              key={label}
              type="button"
              aria-pressed={category === label}
              onClick={() => setCategory(label)}
            >
              {label}
              <span>
                {label === 'All'
                  ? 15
                  : visualizationExamples.filter((example) => example.category === label).length}
              </span>
            </button>
          ))}
        </nav>
      </section>
      <div className="viz-gallery-grid">
        {examples.map((example) => (
          <MarkdownBlock
            key={String(example.spec['type'])}
            text={`\`\`\`ari-viz\n${JSON.stringify(example.spec)}\n\`\`\``}
          />
        ))}
      </div>
      <footer className="viz-gallery-footer">
        Illustrative data · Real reply components · Every Ari theme
      </footer>
    </main>
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('Missing gallery root')
createRoot(root).render(<Gallery />)
