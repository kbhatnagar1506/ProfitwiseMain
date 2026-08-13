"use client"

import { useState, useEffect } from "react"

export function HeroCard() {
  const [currentSlide, setCurrentSlide] = useState(0)

  const slides = ["/images/profitwise-design.png", "/images/profitwise-slide-2.png", "/images/profitwise-slide-3.png"]

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % slides.length)
    }, 2500)

    return () => clearInterval(interval)
  }, [])

  return (
    <div
      className="relative inline-block overflow-hidden rounded-2xl bg-gradient-to-br from-gray-300 via-white to-gray-400 p-[2px] shadow-[0_2px_8px_rgba(0,0,0,0.4),0_8px_24px_rgba(0,0,0,0.2),inset_0_1px_2px_rgba(255,255,255,0.9),inset_0_-1px_2px_rgba(100,100,100,0.5)]"
      key={currentSlide}
      style={{
        animation: "borderFlash 1s ease-in-out, borderPulse 2.5s ease-in-out infinite",
      }}
    >
      <style jsx>{`
        @keyframes borderFlash {
          0% {
            filter: brightness(1.05) drop-shadow(0 0 8px rgba(255, 255, 255, 0.3));
          }
          50% {
            filter: brightness(1.15) drop-shadow(0 0 12px rgba(255, 255, 255, 0.4));
          }
          100% {
            filter: brightness(1) drop-shadow(0 0 4px rgba(255, 255, 255, 0.2));
          }
        }
        
        @keyframes borderPulse {
          0%, 100% {
            box-shadow: 0 2px 8px rgba(0,0,0,0.4), 
                        0 8px 24px rgba(0,0,0,0.2), 
                        inset 0 1px 2px rgba(255,255,255,0.9), 
                        inset 0 -1px 2px rgba(100,100,100,0.5),
                        0 0 6px rgba(255, 255, 255, 0.1);
          }
          50% {
            box-shadow: 0 2px 8px rgba(0,0,0,0.4), 
                        0 8px 24px rgba(0,0,0,0.2), 
                        inset 0 1px 2px rgba(255,255,255,1), 
                        inset 0 -1px 2px rgba(100,100,100,0.5),
                        0 0 12px rgba(255, 255, 255, 0.2);
          }
        }
      `}</style>
      <div className="relative overflow-hidden rounded-[14px] bg-gradient-to-br from-gray-200 via-gray-100 to-gray-300 p-[1px] shadow-[inset_0_2px_4px_rgba(255,255,255,0.8),inset_0_-2px_4px_rgba(0,0,0,0.3)]">
        <div className="relative overflow-hidden rounded-[13px] bg-black w-full h-full">
          {slides.map((slide, index) => (
            <img
              key={slide}
              src={slide || "/placeholder.svg"}
              alt={`ProfitWise Slide ${index + 1}`}
              className={`w-full h-full object-contain rounded-[13px] transition-opacity duration-1000 ${
                index === currentSlide ? "opacity-100 relative" : "opacity-0 absolute inset-0"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
