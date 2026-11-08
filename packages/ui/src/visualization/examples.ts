/** Illustrative data for the development gallery and renderer coverage. Never agent measurements. */
export const visualizationExamples: {
  category: 'Charts' | 'Diagrams' | 'Briefs'
  spec: Record<string, unknown>
}[] = [
  {
    category: 'Charts',
    spec: {
      version: 1,
      type: 'bar',
      title: 'Time back, every week',
      description: 'Illustrative hours spent on routine work before and after automation.',
      unit: 'hours',
      labels: ['Research', 'Review', 'Reporting', 'Planning'],
      series: [
        { name: 'Before', values: [12, 9, 8, 6] },
        { name: 'After', values: [5, 4, 2, 3] },
      ],
    },
  },
  {
    category: 'Charts',
    spec: {
      version: 1,
      type: 'line',
      title: 'A clearer picture of growth',
      description: 'An illustrative monthly trend. Toggle a series to compare.',
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
      series: [
        { name: 'Product', values: [24, 30, 28, 42, 49, 61] },
        { name: 'Services', values: [16, 18, 24, 27, 31, 35] },
      ],
      unit: 'k USD',
    },
  },
  {
    category: 'Charts',
    spec: {
      version: 1,
      type: 'area',
      title: 'Capacity over time',
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      series: [{ name: 'Available', values: [28, 32, 24, 36, 30] }],
      unit: 'hours',
    },
  },
  {
    category: 'Charts',
    spec: {
      version: 1,
      type: 'scatter',
      title: 'Effort and impact',
      xLabel: 'Effort (days)',
      yLabel: 'Impact score',
      series: [
        {
          name: 'Ideas',
          points: [
            { x: 2, y: 8, label: 'Quick fix' },
            { x: 5, y: 6, label: 'Workflow' },
            { x: 8, y: 9, label: 'Platform' },
            { x: 3, y: 4, label: 'Polish' },
          ],
        },
      ],
    },
  },
  {
    category: 'Charts',
    spec: {
      version: 1,
      type: 'pie',
      title: 'Where the budget goes',
      items: [
        { label: 'Engineering', value: 45 },
        { label: 'Design', value: 25 },
        { label: 'Research', value: 20 },
        { label: 'Operations', value: 10 },
      ],
      unit: 'k USD',
    },
  },
  {
    category: 'Charts',
    spec: {
      version: 1,
      type: 'donut',
      title: 'A balanced workday',
      items: [
        { label: 'Building', value: 4 },
        { label: 'Thinking', value: 2 },
        { label: 'Collaborating', value: 1.5 },
        { label: 'Admin', value: 0.5 },
      ],
      unit: 'hours',
    },
  },
  {
    category: 'Charts',
    spec: {
      version: 1,
      type: 'radar',
      title: 'Two approaches, five tradeoffs',
      labels: ['Speed', 'Quality', 'Cost', 'Flexibility', 'Support'],
      series: [
        { name: 'Approach A', values: [8, 7, 9, 5, 6] },
        { name: 'Approach B', values: [6, 9, 6, 9, 8] },
      ],
      unit: '/ 10',
    },
  },
  {
    category: 'Charts',
    spec: {
      version: 1,
      type: 'heatmap',
      title: 'Find the busy windows',
      xLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      yLabels: ['Morning', 'Afternoon', 'Evening'],
      values: [
        [4, 8, 6, 3, 5],
        [8, 9, 7, 8, 4],
        [2, 3, 4, 2, 1],
      ],
      unit: 'meetings',
    },
  },
  {
    category: 'Charts',
    spec: {
      version: 1,
      type: 'treemap',
      title: 'The shape of the backlog',
      items: [
        { label: 'Core platform', value: 34 },
        { label: 'Mobile', value: 22 },
        { label: 'Integrations', value: 18 },
        { label: 'Accessibility', value: 12 },
        { label: 'Documentation', value: 8 },
        { label: 'Maintenance', value: 6 },
      ],
    },
  },
  {
    category: 'Charts',
    spec: {
      version: 1,
      type: 'funnel',
      title: 'From discovery to delivery',
      items: [
        { label: 'Ideas', value: 120 },
        { label: 'Explored', value: 72 },
        { label: 'Prototyped', value: 36 },
        { label: 'Shipped', value: 18 },
      ],
    },
  },
  {
    category: 'Diagrams',
    spec: {
      version: 1,
      type: 'graph',
      title: 'How an answer comes together',
      description: 'A flow diagram connects steps without assigning invented measurements.',
      nodes: [
        { id: 'prompt', label: 'User prompt' },
        { id: 'research', label: 'Research' },
        { id: 'analysis', label: 'Analysis' },
        { id: 'answer', label: 'Answer + visual' },
      ],
      edges: [
        { from: 'prompt', to: 'research' },
        { from: 'prompt', to: 'analysis' },
        { from: 'research', to: 'answer' },
        { from: 'analysis', to: 'answer' },
      ],
    },
  },
  {
    category: 'Diagrams',
    spec: {
      version: 1,
      type: 'timeline',
      title: 'A launch in three chapters',
      events: [
        {
          date: 'Week 1',
          label: 'Explore',
          description: 'Understand the problem and agree on the scope.',
        },
        {
          date: 'Week 2',
          label: 'Build',
          description: 'Prototype the most important workflow.',
          tone: 'info',
        },
        {
          date: 'Week 3',
          label: 'Ship',
          description: 'Validate the result with users.',
          tone: 'success',
        },
      ],
    },
  },
  {
    category: 'Diagrams',
    spec: {
      version: 1,
      type: 'gantt',
      title: 'Work that can happen together',
      unit: 'days from start',
      tasks: [
        { label: 'Discovery', start: 0, end: 3 },
        { label: 'Design', start: 2, end: 6 },
        { label: 'Implementation', start: 5, end: 12 },
        { label: 'Validation', start: 10, end: 14 },
      ],
    },
  },
  {
    category: 'Briefs',
    spec: {
      version: 1,
      type: 'metrics',
      title: 'The numbers that matter',
      items: [
        { label: 'Time saved', value: '24 h', detail: 'Illustrative weekly estimate' },
        { label: 'Steps removed', value: 8, tone: 'info' },
        { label: 'Completion', value: '92%', tone: 'success' },
      ],
    },
  },
  {
    category: 'Briefs',
    spec: {
      version: 1,
      type: 'comparison',
      title: 'Choose with the tradeoffs in view',
      columns: ['Local', 'Cloud'],
      rows: [
        { label: 'Privacy', values: ['Data stays on device', 'Depends on provider'] },
        { label: 'Setup', values: ['Hardware and model required', 'Connect an account'] },
        { label: 'Availability', values: ['Works offline', 'Network required'] },
      ],
    },
  },
]
