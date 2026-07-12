import { BrowserRouter } from 'react-router-dom';
import AppRouter from './router';

function App() {
  // basename：子路径部署时（如 /worktime）所有路由自动加前缀；
  // 空字符串时不传 basename，保持根路径行为。
  return (
    <BrowserRouter basename={__BASE_PATH__ || undefined}>
      <AppRouter />
    </BrowserRouter>
  );
}

export default App;
