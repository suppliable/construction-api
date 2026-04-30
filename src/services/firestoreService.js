'use strict';

const admin = require('../utils/firebaseAdmin');
const { getCustomer, saveCustomer, getCustomerByPhone } = require('../repositories/customerRepository');
const { getCart, saveCart } = require('../repositories/cartRepository');
const { saveOrder, getOrdersByUser, getOrderById, getAllOrders, findOrders, updateOrder, getOrdersByDriver, getOrdersByDriverFiltered, getOrdersPage } = require('../repositories/orderRepository');
const { getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress, getAddressById } = require('../repositories/addressRepository');
const { getSettings, updateSettings, getDeliveryConfig, updateDeliveryConfig, getImageMap, setImage, setFeatured } = require('../repositories/configRepository');
const {
  getDrivers, addDriver, updateDriver, softDeleteDriver,
  getDriverById, getDriverByPhone, getDriverByToken,
  getAllHandoversForDriver, getAllHandoversForDriverFiltered,
  createHandover, getHandoversByDriver, getAllHandovers, getAllHandoversFiltered, getHandoverById, updateHandover,
} = require('../repositories/driverRepository');
const { getVehicles, addVehicle, updateVehicle, deleteVehicle, getVehicleById } = require('../repositories/vehicleRepository');

module.exports = {
  db: admin.firestore(),
  // customers
  getCustomer, saveCustomer, getCustomerByPhone,
  // cart
  getCart, saveCart,
  // orders
  saveOrder, getOrdersByUser, getOrderById, getAllOrders, findOrders, updateOrder, getOrdersByDriver, getOrdersByDriverFiltered, getOrdersPage,
  // addresses
  getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress, getAddressById,
  // config
  getSettings, updateSettings, getDeliveryConfig, updateDeliveryConfig, getImageMap, setImage, setFeatured,
  // drivers + handovers
  getDrivers, addDriver, updateDriver, softDeleteDriver,
  getDriverById, getDriverByPhone, getDriverByToken,
  getAllHandoversForDriver, getAllHandoversForDriverFiltered,
  createHandover, getHandoversByDriver, getAllHandovers, getAllHandoversFiltered, getHandoverById, updateHandover,
  // vehicles
  getVehicles, addVehicle, updateVehicle, deleteVehicle, getVehicleById,
};
