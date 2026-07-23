import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({
  BrowserRouter: ({ basename, children }: any) => (
    <div data-testid="browser-router" data-basename={basename}>{children}</div>
  ),
}));
vi.mock('@client/router', () => ({ default: () => <main>应用路由</main> }));

import App from '@client/App';

describe('App', () => {
  it('在根路径配置下挂载浏览器路由和应用路由', () => {
    render(<App />);
    expect(screen.getByTestId('browser-router')).not.toHaveAttribute('data-basename');
    expect(screen.getByText('应用路由')).toBeInTheDocument();
  });
});
