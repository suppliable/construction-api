const products = [
    {
      id: "P001",
      name: "UltraTech Cement PPC",
      brand: "ULTRATECH",
      category: "Cement",
      unit: "bag",
      description: "Premium Portland Pozzolana Cement for strong walls and roofs.",
      hasVariants: false,
      price: 450,
      gst_percentage: 28,
      image: "https://placehold.co/400x300?text=UltraTech+Cement",
      fallbackImage: "https://placehold.co/400x300?text=Cement"
    },
    {
      id: "P002",
      name: "JSW Neosteel TMT Bars",
      brand: "JSW STEEL",
      category: "Steel",
      unit: "kg",
      description: "High strength TMT bars for residential and commercial construction.",
      hasVariants: true,
      priceRange: "₹560 - ₹2,200",
      gst_percentage: 18,
      image: "https://placehold.co/400x300?text=JSW+Steel",
      fallbackImage: "https://placehold.co/400x300?text=Steel",
      variants: [
        { id: "P002-V1", name: "8mm", price: 560, stock: 500 },
        { id: "P002-V2", name: "10mm", price: 840, stock: 350 },
        { id: "P002-V3", name: "12mm", price: 1100, stock: 200 },
        { id: "P002-V4", name: "16mm", price: 1600, stock: 150 },
        { id: "P002-V5", name: "20mm", price: 2200, stock: 100 }
      ]
    },
    {
      id: "P003",
      name: "Red Clay Bricks",
      brand: "LOCAL KILN",
      category: "Bricks",
      unit: "piece",
      description: "Standard red clay bricks for walls and foundations.",
      hasVariants: false,
      price: 8,
      gst_percentage: 5,
      image: "https://placehold.co/400x300?text=Red+Bricks",
      fallbackImage: "https://placehold.co/400x300?text=Bricks"
    },
    {
      id: "P004",
      name: "River Sand",
      brand: "NATURAL",
      category: "Sand",
      unit: "cubic ft",
      description: "Clean river sand for plastering and concrete mixing.",
      hasVariants: false,
      price: 55,
      gst_percentage: 5,
      image: "https://placehold.co/400x300?text=River+Sand",
      fallbackImage: "https://placehold.co/400x300?text=Sand"
    },
    {
      id: "P005",
      name: "Crushed Stone Aggregate",
      brand: "NATURAL",
      category: "Aggregate",
      unit: "cubic ft",
      description: "20mm crushed stone aggregate for RCC work.",
      hasVariants: true,
      priceRange: "₹45 - ₹65",
      gst_percentage: 5,
      image: "https://placehold.co/400x300?text=Aggregate",
      fallbackImage: "https://placehold.co/400x300?text=Aggregate",
      variants: [
        { id: "P005-V1", name: "10mm", price: 45, stock: 800 },
        { id: "P005-V2", name: "20mm", price: 55, stock: 600 },
        { id: "P005-V3", name: "40mm", price: 65, stock: 400 }
      ]
    },
    {
      id: "P006",
      name: "Ambuja Cement OPC 53",
      brand: "AMBUJA",
      category: "Cement",
      unit: "bag",
      description: "Ordinary Portland Cement Grade 53 for high strength concrete.",
      hasVariants: false,
      price: 470,
      gst_percentage: 28,
      image: "https://placehold.co/400x300?text=Ambuja+Cement",
      fallbackImage: "https://placehold.co/400x300?text=Cement"
    }
  ];
  
  module.exports = products;