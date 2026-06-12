package com.globus.crm.feature.auth.domain.model

data class PatientPermissions(val permissions: Set<String>) {
    fun has(permission: String): Boolean = permission in permissions

    companion object {
        val EMPTY = PatientPermissions(emptySet())
        const val PRESCRIPTIONS_READ = "my_prescriptions.read"
        const val PRODUCTS_READ = "products.read"
    }
}
