import React from 'react';

export default function Bitrix24Icon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      className="h-6 w-6"
      id="bitrix24"
    >
      <defs>
        <linearGradient id="bitrix24-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#00aeef" />
          <stop offset="100%" stopColor="#2dbeea" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#bitrix24-gradient)" />
      <g>
        <path
          d="M24.5 14c-5.8 0-10.5 4.7-10.5 10.5s4.7 10.5 10.5 10.5 10.5-4.7 10.5-10.5S30.3 14 24.5 14zm0 19c-4.7 0-8.5-3.8-8.5-8.5S19.8 16 24.5 16s8.5 3.8 8.5 8.5-3.8 8.5-8.5 8.5z"
          fill="#fff"
        />
        <circle cx="32" cy="32" r="3" fill="#fff" />
      </g>
      <text
        x="24"
        y="30"
        textAnchor="middle"
        fontFamily="Arial, Helvetica, sans-serif"
        fontWeight="bold"
        fontSize="10"
        fill="#fff"
      >
        24
      </text>
    </svg>
  );
}