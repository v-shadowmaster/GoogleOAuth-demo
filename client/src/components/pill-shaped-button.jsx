import React from 'react';


// Reusable Button Component
export const Button = ({
    children,
    variant = 'primary',
    onClick,
    type = 'button',
    className = ''
}) => {
    const baseStyles = 'w-full py-3 sm:py-3.5 px-4 sm:px-6 rounded-full text-sm sm:text-base font-medium transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer';

    const variants = {
        primary: 'bg-black text-white hover:bg-gray-800 active:scale-98',
        secondary: 'bg-white text-black border-2 border-gray-200 hover:bg-gray-50 active:scale-98',
        outline: 'bg-transparent text-black border border-gray-300 hover:bg-gray-50 active:scale-98'
    };

    return (
        <button
            type={type}
            onClick={onClick}
            className={`${baseStyles} ${variants[variant]} ${className}`}
        >
            {children}
        </button>
    );
};