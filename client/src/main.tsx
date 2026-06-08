import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#6B8F71',
          borderRadius: 12,
          fontFamily: '"Figtree", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          colorBgContainer: '#FDFBF7',
          colorBgLayout: '#F8F4ED',
          colorText: '#2C2418',
          colorTextSecondary: '#7A7060',
          colorBorder: '#E8E0D4',
          colorBgBase: '#FDFBF7',
        },
        components: {
          Card: {
            borderRadiusLG: 16,
            colorBorderSecondary: '#E8E0D4',
          },
          Button: {
            borderRadius: 10,
            primaryShadow: 'none',
          },
          Input: {
            borderRadius: 10,
          },
          Select: {
            borderRadius: 10,
          },
          Menu: {
            borderRadius: 10,
          },
          Table: {
            borderRadius: 12,
          },
          Modal: {
            borderRadiusLG: 16,
          },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
