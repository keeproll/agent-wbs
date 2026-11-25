import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { MENU } from './menu.ts';

function Icon({ d }: { d: string }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="app">
      <a className="skip" href="#main">
        본문으로 건너뛰기
      </a>
      <header className="hdr">
        <button
          type="button"
          className="iconbtn"
          aria-label="메뉴 접기/펼치기"
          aria-expanded={!collapsed}
          aria-controls="nav"
          onClick={() => {
            setCollapsed(!collapsed);
          }}
        >
          <Icon d="M4 6h16M4 12h16M4 18h16" />
        </button>
        <div className="brand">
          <span className="logo" aria-hidden="true">
            AW
          </span>
          <span>Agent WBS</span>
        </div>
      </header>
      <div className="body">
        <nav id="nav" className={collapsed ? 'nav collapsed' : 'nav'} aria-label="주 메뉴">
          {MENU.map((item) => (
            <NavLink
              key={item.key}
              to={`/${item.key}`}
              className={({ isActive }) => (isActive ? 'nav-i on' : 'nav-i')}
              aria-label={item.label}
              title={item.label}
            >
              <Icon d={item.icon} />
              <span className="nav-l">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <main id="main" className="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
