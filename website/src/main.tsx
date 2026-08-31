import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './index.css';
import Layout from './components/Layout';
import Home from './pages/Home';
import Projects from './pages/Projects';
import Leads from './pages/Leads';
import Sponsors from './pages/Sponsors';
import Join from './pages/Join';

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/projects', element: <Projects /> },
      { path: '/leads', element: <Leads /> },
      { path: '/sponsors', element: <Sponsors /> },
      { path: '/join', element: <Join /> },
      { path: '*', element: <Home /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
